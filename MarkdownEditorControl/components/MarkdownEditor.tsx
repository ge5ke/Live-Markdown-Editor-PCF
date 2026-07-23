import * as React from 'react';
import { useEffect, useState, useCallback, useRef } from 'react';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, parserCtx, serializerCtx } from '@milkdown/core';
import { insertImageCommand } from '@milkdown/preset-commonmark';
import { history } from '@milkdown/plugin-history';
import { clipboard } from '@milkdown/plugin-clipboard';
import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';

// Import security utilities
import { validateImageSize, validateLinkUrl, validateImageUrl } from '../utils/security';
import { handleError } from '../utils/errorHandler';
import {
    DEBOUNCE_SERIALIZE_MS,
    COPY_SUCCESS_TIMEOUT_MS,
    TABLE_GRID_SIZE,
    TABLE_MIN_ROWS
} from '../utils/constants';

// Import custom hooks
import { useEditorCommands, useTableOperations } from '../hooks';

// Lucide Icons
import {
    Undo2,
    Redo2,
    Bold,
    Italic,
    Strikethrough,
    Heading1,
    Heading2,
    Heading3,
    Pilcrow,
    Link,
    Image,
    List,
    ListOrdered,
    Code,
    Table,
    Quote,
    Minus,
    Copy,
    Check,
    ChevronDown,
    Plus,
    Trash2,
} from 'lucide-react';

// Module-level regex constants (compiled once)
const WORD_MATCH_REGEX = /\S+/g;

export interface MarkdownStats {
    words: number;
    chars: number;
}

export interface MarkdownEditorProps {
    value: string;
    onChange: (value: string, stats: MarkdownStats) => void;
    readOnly?: boolean;
    showToolbar?: boolean;
    enableSpellCheck?: boolean;
    maxLength?: number;
    height?: number;
    width?: number;
    toolbarSize?: 'sm' | 'md' | 'lg';
}

// Hard-blocks any transaction that would grow the document's rendered text past maxLength.
// maxLength is read from a ref (rather than closed over as a plain number) so a single plugin
// instance, created once at editor-creation time, keeps enforcing the CURRENT maxLength even as
// the host changes the prop later - the alternative (recreating the editor on every maxLength
// change) would blow away undo history and cursor position.
//
// KNOWN LIMIT: the enforced metric is rendered text length (doc.textContent), not the length of
// the serialized markdown string. Markdown syntax adds overhead (e.g. "**bold**" serializes to
// more characters than the "bold" text it renders), so the persisted markdown can end up longer
// than maxLength even though every keystroke was blocked at this boundary. Makers must set
// maxLength below the Dataverse column's real limit, with headroom for that overhead.
const createMaxLengthGuardPlugin = (maxLengthRef: React.MutableRefObject<number>) =>
    $prose(() => new Plugin({
        key: new PluginKey('markdown-editor-max-length-guard'),
        filterTransaction: (tr) => {
            if (!tr.docChanged) return true;
            return tr.doc.textContent.length <= maxLengthRef.current;
        }
    }));

const EditorComponent: React.FC<Omit<MarkdownEditorProps, 'onChange'> & {
    onUpdate: (markdown: string, stats: MarkdownStats) => void;
}> = ({
    value,
    onUpdate,
    readOnly = false,
    showToolbar = true,
    enableSpellCheck = true,
    maxLength = 100000,
    height,
    width,
    toolbarSize = 'md'
}) => {
    // Use refs instead of state for stats to avoid re-renders on every keystroke.
    // Seed from the initial value so the status bar is correct before the first edit.
    const wordCountRef = useRef((value.match(WORD_MATCH_REGEX) || []).length);
    const charCountRef = useRef(value.length);
    const [editorError, setEditorError] = useState<string | null>(null);
    const [copyStatus, setCopyStatus] = useState<'idle' | 'copied'>('idle');
    const [showTablePicker, setShowTablePicker] = useState(false);
    const [tableSize, setTableSize] = useState<{ rows: number; cols: number }>({ rows: 3, cols: 3 });
    const [hoveredCell, setHoveredCell] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
    // Insert Link / Insert Image popovers (replace window.prompt/window.alert). Only one is ever
    // open at a time, alongside the table picker.
    const [activePopover, setActivePopover] = useState<'link' | 'image' | null>(null);
    const [linkUrl, setLinkUrl] = useState('');
    const [linkText, setLinkText] = useState('');
    const [linkError, setLinkError] = useState<string | null>(null);
    const [imageUrl, setImageUrl] = useState('');
    const [imageAlt, setImageAlt] = useState('');
    const [imageError, setImageError] = useState<string | null>(null);
    const editorRef = useRef<Editor | null>(null);
    const currentMarkdownRef = useRef<string>(value);
    // The last markdown actually DELIVERED to the host via onUpdate - distinct from
    // currentMarkdownRef, which the debounced serialize (and flush) update without necessarily
    // notifying. flush() compares its freshly-serialized output against this ref to decide
    // whether onUpdate is actually needed.
    const lastNotifiedRef = useRef<string>(value);
    // Bookkeeping only now (see flush()'s comment) - true whenever the doc has unflushed edits,
    // set synchronously on every ProseMirror update, cleared once flush() has run. flush() must
    // NOT gate on this: @milkdown/plugin-listener internally debounces the `updated` callback by
    // ~200ms, so this flag can still read false immediately after a keystroke.
    const isDirtyRef = useRef(false);
    const serializeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const getEditorRef = useRef<(() => Editor | undefined) | undefined>(undefined);
    // Kept in sync via effect below so flush() can read the latest maxLength without
    // needing it as a dependency - onUpdate is the only thing that should ever change
    // flush's identity, since flush is called from unmount cleanup where a churning
    // identity would otherwise re-fire the cleanup (and thus flush) on every maxLength change.
    const maxLengthRef = useRef(maxLength);
    useEffect(() => {
        maxLengthRef.current = maxLength;
    }, [maxLength]);
    // Kept in sync via effect below so the editable() closure passed to ProseMirror at editor
    // creation time always reads the latest readOnly value, not the value from mount time.
    const readOnlyRef = useRef(readOnly);
    // Per-instance DOM refs for the status bar spans - replaces document.getElementById, which
    // would collide across multiple control instances on the same page sharing the same id.
    const wordCountElRef = useRef<HTMLSpanElement | null>(null);
    const charCountElRef = useRef<HTMLSpanElement | null>(null);

    // Calculate statistics (optimized - uses refs + direct DOM updates to avoid re-renders).
    // `text` must be doc.textContent (rendered text), NOT the serialized markdown string - that
    // is the single source of truth for both the word and character counts, shared by every
    // call site (live typing preview, flush, and external value sync) so the status bar and the
    // characterCount/wordCount outputs can never disagree.
    const updateStats = useCallback((text: string) => {
        const chars = text.length;
        const wordMatches = text.match(WORD_MATCH_REGEX);
        const words = wordMatches ? wordMatches.length : 0;

        // Update refs (no re-render)
        wordCountRef.current = words;
        charCountRef.current = chars;

        // Update DOM directly for instant feedback without re-render
        if (wordCountElRef.current) wordCountElRef.current.textContent = `Words: ${words}`;
        if (charCountElRef.current) charCountElRef.current.textContent = `Characters: ${chars} / ${maxLengthRef.current}`;

        return { words, chars };
    }, []);

    // Initialize Milkdown editor using React hooks following v7 pattern
    const { loading, get } = useEditor((root) => {
        try {
            const editor = Editor
                .make()
                .config((ctx) => {
                    ctx.set(rootCtx, root);
                    ctx.set(defaultValueCtx, value);
                    // ProseMirror-level non-editability (not CSS): editable is re-evaluated by
                    // ProseMirror on every relevant check, so reading readOnlyRef here means a
                    // later readOnly change (applied via view.setProps below) takes effect
                    // immediately without recreating the editor. spellcheck/aria-label are set
                    // here from the initial props and kept current by the effect below.
                    ctx.update(editorViewOptionsCtx, (prev) => ({
                        ...prev,
                        editable: () => !readOnlyRef.current,
                        attributes: {
                            ...prev.attributes,
                            spellcheck: String(enableSpellCheck),
                            'aria-label': 'Markdown editor'
                        }
                    }));
                })
                .config((ctx) => {
                    const listenerPlugin = ctx.get(listenerCtx);
                    // ULTRA-MINIMAL keystroke handler - do almost nothing synchronously
                    // All expensive work is deferred to prevent ANY typing lag
                    listenerPlugin.updated((_ctx, doc) => {
                        // Mark dirty synchronously so flush() knows there is unsaved content,
                        // even before the debounced serialize below has run.
                        isDirtyRef.current = true;

                        // Clear existing timeout and set new one - this is the ONLY other sync work
                        if (serializeTimeoutRef.current) {
                            clearTimeout(serializeTimeoutRef.current);
                        }

                        // Defer serialization + stats to after typing stops.
                        // NOTE: does NOT call onUpdate - notification now happens only on flush (blur/unmount).
                        serializeTimeoutRef.current = setTimeout(() => {
                            try {
                                // Serialize to markdown
                                const serializer = ctx.get(serializerCtx);
                                let markdown = serializer(doc);
                                // An emptied document can serialize to whitespace (e.g. a lone newline)
                                // rather than "" - normalize so clearing the field yields a true empty output.
                                if (/^\s*$/.test(markdown)) {
                                    markdown = '';
                                }
                                currentMarkdownRef.current = markdown;

                                // Update stats from the rendered doc text (single source of truth),
                                // not the serialized markdown - see updateStats' comment.
                                updateStats(doc.textContent);

                                serializeTimeoutRef.current = null;
                            } catch (error) {
                                handleError(error, { component: 'MarkdownEditor', action: 'serialize' });
                            }
                        }, DEBOUNCE_SERIALIZE_MS);
                    });
                })
                .use(commonmark)
                .use(gfm)
                .use(history)
                .use(listener)
                .use(clipboard)
                .use(createMaxLengthGuardPlugin(maxLengthRef));

            editorRef.current = editor;
            return editor;
        } catch (error) {
            setEditorError(error instanceof Error ? error.message : 'Unknown error');
            throw error;
        }
    }, []);

    // Sync stable editor reference for use in callbacks
    useEffect(() => {
        getEditorRef.current = get;
    }, [get]);

    // Stable getEditor function for hooks
    const getEditor = useCallback(() => get?.(), [get]);

    // Flush any pending debounced serialize and, if the doc has unflushed edits, notify the
    // parent. Synchronous (no setTimeout) so it is safe to call from a blur handler and from
    // unmount cleanup, where the caller needs the notify to have happened before returning.
    // Declared above the readOnly-toggle effect below (rather than near the unmount-flush effect
    // further down) because that effect must call it too - flush()'s own identity depends only
    // on onUpdate (updateStats' identity is stable, deps []), so it does not churn across
    // unrelated re-renders.
    const flush = useCallback(() => {
        // Serializes UNCONDITIONALLY - deliberately does not gate on isDirtyRef.
        // @milkdown/plugin-listener v7.20 internally debounces its `updated` callback by ~200ms
        // (see node_modules/@milkdown/plugin-listener/lib/index.js), which is where isDirtyRef
        // gets set. If focus leaves the container within that window (e.g. typing then
        // immediately clicking a Save button), isDirtyRef can still read false even though the
        // doc has just-typed, un-notified content - so isDirtyRef's timing cannot be trusted to
        // decide whether a flush is needed. Instead, flush always re-serializes the live doc and
        // compares the result against lastNotifiedRef (what the host actually has); onUpdate only
        // fires when that comparison shows a real difference, so a flush with nothing new to
        // report costs one serialize but never produces a spurious notify.
        const editor = getEditorRef.current?.();
        if (editor) {
            try {
                const view = editor.ctx.get(editorViewCtx);
                const serializer = editor.ctx.get(serializerCtx);
                if (view && serializer) {
                    // The pending debounced serialize's work is now done synchronously below, so
                    // cancel it - letting it fire later would just redundantly reserialize the
                    // same (or since-superseded) doc state without notifying anyone.
                    if (serializeTimeoutRef.current) {
                        clearTimeout(serializeTimeoutRef.current);
                        serializeTimeoutRef.current = null;
                    }

                    let markdown = serializer(view.state.doc);
                    if (/^\s*$/.test(markdown)) {
                        markdown = '';
                    }
                    currentMarkdownRef.current = markdown;
                    updateStats(view.state.doc.textContent);

                    if (markdown !== lastNotifiedRef.current) {
                        onUpdate(markdown, { words: wordCountRef.current, chars: charCountRef.current });
                        lastNotifiedRef.current = markdown;
                    }
                    isDirtyRef.current = false;
                    return;
                }
            } catch (error) {
                handleError(error, { component: 'MarkdownEditor', action: 'flush' });
            }
        }

        // Fallback - no editor/view/serializer available (e.g. mid-teardown), or serialization
        // threw above: deliver whatever currentMarkdownRef last held (e.g. from the debounced
        // serialize) rather than silently dropping a pending edit, still gated on lastNotifiedRef
        // so an unchanged value never produces a spurious notify.
        if (currentMarkdownRef.current !== lastNotifiedRef.current) {
            onUpdate(currentMarkdownRef.current, { words: wordCountRef.current, chars: charCountRef.current });
            lastNotifiedRef.current = currentMarkdownRef.current;
        }
        isDirtyRef.current = false;
    }, [onUpdate, updateStats]);

    // Toggle ProseMirror-level editability at runtime (e.g. the host form flips
    // isControlDisabled). Updates the ref the editable() closure above reads, then forces the
    // live view to re-read its props - editable is a function, so ProseMirror re-invokes it on
    // relevant checks, but setProps is what makes it pick up a *changed* closure result now.
    useEffect(() => {
        readOnlyRef.current = readOnly;

        const editor = get?.();
        if (!editor) return;

        try {
            // Flush BEFORE disabling editability. Once readOnly is true, this same render's
            // effect cleanup tears down the focusout listener (see the flush-on-focusout effect
            // below, which bails out entirely when readOnly), and the only remaining flush
            // trigger is unmount - so any edit still unflushed at this instant would otherwise
            // sit silently discarded until (and unless) the component unmounts. flush() is a
            // no-op when there is nothing dirty, so this is safe to call on every readOnly
            // transition, not just true->false.
            if (readOnly) {
                flush();
            }

            const view = editor.ctx.get(editorViewCtx);
            view?.setProps({ editable: () => !readOnlyRef.current });
        } catch (error) {
            handleError(error, { component: 'MarkdownEditor', action: 'applyReadOnly' });
        }
    }, [readOnly, get, flush]);

    // Apply spellcheck changes to the live view the same way readOnly is applied above.
    useEffect(() => {
        const editor = get?.();
        if (!editor) return;

        try {
            const view = editor.ctx.get(editorViewCtx);
            view?.setProps({
                attributes: {
                    spellcheck: String(enableSpellCheck),
                    'aria-label': 'Markdown editor'
                }
            });
        } catch (error) {
            handleError(error, { component: 'MarkdownEditor', action: 'applySpellCheck' });
        }
    }, [enableSpellCheck, get]);

    // Flush on unmount so edits pending at destroy time are never lost. React runs effect
    // cleanups synchronously during root.unmount(), so this delivers onUpdate before it returns.
    // Invariant this depends on: @milkdown/react's own cleanup calls editor.destroy() as a
    // fire-and-forget async call (it does not await it, and React does not wait for it either),
    // so the editor ctx (view/serializer, read inside flush() via getEditorRef) is still valid
    // synchronously here, before destroy() has had a chance to tear anything down. Verified
    // against the vendored source in node_modules/@milkdown/react/lib/index.js (useGetEditor's
    // cleanup: `() => { editor.destroy().catch(console.error); }`), @milkdown/react +
    // @milkdown/core 7.20.0.
    useEffect(() => {
        return () => {
            flush();
        };
    }, [flush]);

    // Flush when focus leaves the editor container entirely (blur-to-elsewhere). Moving focus
    // between elements inside the container (e.g. editor -> toolbar button) must NOT flush.
    // Never attached when readOnly: a read-only editor can never become dirty, and flush() must
    // never fire onUpdate for one.
    useEffect(() => {
        if (readOnly) return;

        const container = containerRef.current;
        if (!container) return;

        const handleFocusOut = (e: FocusEvent) => {
            const related = e.relatedTarget as Node | null;
            if (!related || !container.contains(related)) {
                flush();
            }
        };

        container.addEventListener('focusout', handleFocusOut);
        return () => container.removeEventListener('focusout', handleFocusOut);
    }, [flush, readOnly]);

    // Use extracted hooks for editor commands
    const editorCommands = useEditorCommands({ getEditor });

    // Use extracted hooks for table operations
    const tableOperations = useTableOperations({
        getEditor,
        onComplete: () => setShowTablePicker(false)
    });

    // Apply external value changes (e.g. late-arriving or refreshed Dataverse data) to the doc.
    // Only applies when value actually differs from the editor's own content AND the user has no
    // unflushed edits - if the user is mid-edit, the external value is dropped until their next
    // flush overwrites it. Replaces the old "sync when empty" effect, which could resurrect
    // deleted content because it only ever looked at whether the editor was empty.
    useEffect(() => {
        if (isDirtyRef.current) return;
        if (value === currentMarkdownRef.current) return;

        const editor = get?.();
        if (!editor) return;

        try {
            const view = editor.ctx.get(editorViewCtx);
            const parser = editor.ctx.get(parserCtx);
            if (!view || !parser) return;

            const { state, dispatch } = view;
            // parser("") still yields a doc (an empty paragraph); the fallback below only
            // matters if a future parser implementation ever returns a falsy value for empty input.
            const parsedDoc = parser(value) ?? state.schema.topNodeType.createAndFill();
            if (!parsedDoc) return;

            // Cancel any pending debounced serialize before replacing the doc below - the doc it
            // would have serialized is about to be replaced wholesale, so letting it fire later
            // would clobber currentMarkdownRef with a stale, pre-external-apply serialization.
            if (serializeTimeoutRef.current) {
                clearTimeout(serializeTimeoutRef.current);
                serializeTimeoutRef.current = null;
            }

            const tr = state.tr.replaceWith(0, state.doc.content.size, parsedDoc.content);
            dispatch(tr);

            currentMarkdownRef.current = value;
            // The host already owns this value (it is the very value we just applied), so it is
            // also, by definition, the last value the host was notified of - record it here too.
            // This makes the listener's late debounced callback (see comment below) fully
            // harmless: a later flush() re-serializes identical content, compares equal against
            // lastNotifiedRef, and correctly skips onUpdate instead of bouncing the host's own
            // value back to it.
            lastNotifiedRef.current = value;
            // tr.doc reflects the doc after the replaceWith step above - use its rendered text,
            // not the raw external markdown string, to keep chars/words on the same metric as
            // every other call site (markdown syntax length != rendered text length).
            updateStats(tr.doc.textContent);
            // The dispatch above re-enters @milkdown/plugin-listener's own internal ~200ms
            // debounce (see its `apply`/`debouncedHandler`), which will eventually invoke our
            // `updated` listener registered in the useEditor factory and set isDirtyRef.current =
            // true for this transaction - even though it originated from the host `value` prop,
            // not the user. A synchronous set/clear guard around dispatch() cannot suppress that,
            // because the listener plugin's own debounce means `updated` fires asynchronously,
            // well after any synchronous guard here would already have been reset. So instead:
            // currentMarkdownRef was just set to `value` above, meaning the editor now exactly
            // mirrors the host value with nothing pending - reset isDirtyRef here so a later
            // readOnly-toggle flush or unmount-flush does not deliver this host-originated
            // content back to the host as if it were a user edit. Even if isDirtyRef does get
            // re-marked true by that late callback, flush() no longer trusts it either way (see
            // flush()'s own comment) - it will just re-serialize and find nothing changed.
            isDirtyRef.current = false;
        } catch (error) {
            handleError(error, { component: 'MarkdownEditor', action: 'applyExternalValue' });
        }
    }, [value, get, updateStats]);

    // Destructure commands from hook for cleaner JSX usage
    const {
        insertHeading, clearHeading, toggleBold, toggleItalic, toggleStrikethrough,
        handleUndo, handleRedo, insertBlockquote, insertHorizontalRule,
        insertBulletList, insertOrderedList, insertCode,
        insertTable: insertTableCommand_fn, executeCommand
    } = editorCommands;

    // Destructure table operations from hook
    const { addTableRow, addTableColumn, deleteTableRow, deleteTableColumn, deleteTable } = tableOperations;

    // Toggle table picker visibility
    const toggleTablePicker = () => {
        setActivePopover(null);
        setShowTablePicker(!showTablePicker);
        setHoveredCell({ row: 0, col: 0 });
    };

    // Insert table with specified dimensions (minimum 2 rows to have header + data)
    const insertTableWithSize = (rows: number, cols: number) => {
        insertTableCommand_fn(rows, cols);
        setShowTablePicker(false);
        setHoveredCell({ row: 0, col: 0 });
    };

    // Open the Insert Link popover, prefilling the display-text field with the current
    // selection (matches the old prompt flow's default) so the toolbar button alone triggers it.
    const openLinkPopover = useCallback(() => {
        let selectedText = '';
        const editor = getEditor();
        if (editor) {
            try {
                const view = editor.ctx.get(editorViewCtx);
                if (view) {
                    const { selection, doc } = view.state;
                    selectedText = doc.textBetween(selection.from, selection.to);
                }
            } catch (error) {
                handleError(error, { component: 'MarkdownEditor', action: 'openLinkPopover' });
            }
        }
        setLinkUrl('https://');
        setLinkText(selectedText);
        setLinkError(null);
        setShowTablePicker(false);
        setActivePopover((prev) => (prev === 'link' ? null : 'link'));
    }, [getEditor]);

    // Validation errors render inline in the popover (never window.alert) - see validateLinkUrl.
    const handleInsertLink = useCallback(() => {
        const validation = validateLinkUrl(linkUrl);
        // sanitized is always present when valid is true, but the extra check keeps the
        // compiler-narrowed type a plain string and guarantees the raw linkUrl is never used.
        if (!validation.valid || !validation.sanitized) {
            setLinkError(validation.error ?? 'Invalid URL');
            return;
        }

        const editor = getEditor();
        if (!editor) return;

        try {
            const view = editor.ctx.get(editorViewCtx);
            if (!view) return;

            const { state, dispatch } = view;
            const href = validation.sanitized;
            const displayText = linkText.trim() || href;
            const linkMark = state.schema.marks.link;

            if (linkMark) {
                const mark = linkMark.create({ href, title: '' });
                const textNode = state.schema.text(displayText, [mark]);
                const tr = state.tr.replaceSelectionWith(textNode, false);
                dispatch(tr);
            }

            setActivePopover(null);
            view.focus();
        } catch (error) {
            handleError(error, { component: 'MarkdownEditor', action: 'insertLink' });
        }
    }, [getEditor, linkUrl, linkText]);

    const openImagePopover = useCallback(() => {
        setImageUrl('https://');
        setImageAlt('');
        setImageError(null);
        setShowTablePicker(false);
        setActivePopover((prev) => (prev === 'image' ? null : 'image'));
    }, []);

    // Validation errors render inline in the popover (never window.alert) - see validateImageUrl.
    const handleInsertImage = useCallback(() => {
        const validation = validateImageUrl(imageUrl);
        // sanitized is always present when valid is true, but the extra check keeps the
        // compiler-narrowed type a plain string and guarantees the raw imageUrl is never used.
        if (!validation.valid || !validation.sanitized) {
            setImageError(validation.error ?? 'Invalid image URL');
            return;
        }

        executeCommand(insertImageCommand.key, {
            src: validation.sanitized,
            alt: imageAlt.trim() || 'image'
        });
        // executeCommand already refocuses the view, but do so explicitly too (matching
        // handleInsertLink above) since insertion itself may fail silently (e.g. no image node
        // at schema) and popover close should not depend on that.
        const editor = getEditor();
        editor?.ctx.get(editorViewCtx)?.focus();
        setActivePopover(null);
    }, [executeCommand, getEditor, imageUrl, imageAlt]);

    const copyToClipboard = async () => {
        try {
            await navigator.clipboard.writeText(currentMarkdownRef.current);
            setCopyStatus('copied');
            setTimeout(() => setCopyStatus('idle'), COPY_SUCCESS_TIMEOUT_MS);
        } catch (error) {
            handleError(error, { component: 'MarkdownEditor', action: 'copyToClipboard' }, 'warning');
        }
    };

    // Close dropdowns (table picker + link/image popovers) on outside click or Escape. Single
    // shared mechanism for all three - extend here rather than adding a duplicate effect.
    useEffect(() => {
        if (!showTablePicker && activePopover === null) return;

        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setShowTablePicker(false);
                setActivePopover(null);
            }
        };
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setShowTablePicker(false);
                setActivePopover(null);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [showTablePicker, activePopover]);

    // Handle paste events for images. Markdown paste is now handled by @milkdown/plugin-clipboard
    // (registered in the .use() chain above), which parses pasted markdown/HTML properly instead
    // of the previous heuristic-based looksLikeMarkdown() detector.
    const handlePaste = useCallback((e: Event) => {
        const clipboardEvent = e as ClipboardEvent;
        const items = clipboardEvent.clipboardData?.items;
        if (!items) return;

        for (const item of Array.from(items)) {
            if (!item.type.startsWith('image/')) continue;

            // Only claim the event once we actually have a file to handle - inspecting
            // clipboardData.items does not by itself mean getAsFile() will succeed. Calling
            // preventDefault/stopPropagation before that check would swallow the paste (e.g.
            // falling through to plugin-clipboard's markdown handling) even when there is
            // nothing here to insert.
            const file = item.getAsFile();
            if (!file) continue;

            e.preventDefault();
            e.stopPropagation();

            // Validate image size
            const sizeValidation = validateImageSize(file);
            if (!sizeValidation.valid) {
                // Mid-paste alert is intentional: there is no anchor UI to render an inline
                // error against at this point in the flow.
                window.alert(sizeValidation.error);
                return;
            }

            try {
                // Convert image to base64 data URL
                const reader = new FileReader();
                reader.onload = (event) => {
                    const dataUrl = event.target?.result as string;
                    if (dataUrl) {
                        // Insert the image into the editor
                        executeCommand(insertImageCommand.key, {
                            src: dataUrl,
                            alt: file.name || 'pasted-image'
                        });
                    }
                };
                reader.readAsDataURL(file);
            } catch (error) {
                handleError(error, { component: 'MarkdownEditor', action: 'pasteImage' });
            }
            return; // Image handled, exit
        }
    }, [executeCommand]);

    // Attach the paste handler to the ProseMirror root DOM node itself (not the whole
    // container), so it never intercepts paste into the popover URL/text inputs. Capture phase
    // to intercept before ProseMirror/plugin-clipboard sees it. Never attached when readOnly:
    // nothing can be pasted into a non-editable editor.
    useEffect(() => {
        if (readOnly) return;

        const editor = get?.();
        if (!editor) return;

        let proseMirrorDom: HTMLElement | undefined;
        try {
            proseMirrorDom = editor.ctx.get(editorViewCtx)?.dom;
        } catch (error) {
            handleError(error, { component: 'MarkdownEditor', action: 'attachPasteListener' });
        }
        if (!proseMirrorDom) return;

        proseMirrorDom.addEventListener('paste', handlePaste, true);
        return () => proseMirrorDom?.removeEventListener('paste', handlePaste, true);
    }, [handlePaste, readOnly, get]);

    // Determine responsive class based on width
    const getResponsiveClass = () => {
        if (!width) return '';
        if (width < 400) return 'very-compact';
        if (width < 600) return 'compact';
        return '';
    };

    return (
        <div
            ref={containerRef}
            className={`markdown-editor-container ${readOnly ? 'read-only' : ''} ${getResponsiveClass()}`}
            style={height ? { height: `${height}px`, minHeight: `${height}px`, maxHeight: `${height}px` } : undefined}
        >
            {showToolbar && !readOnly && (
                <div className={`markdown-toolbar toolbar-${toolbarSize}`}>
                    {/* History Group */}
                    <div className="toolbar-group" aria-label="History">
                        <button
                            className="toolbar-button"
                            onClick={handleUndo}
                            title="Undo (Ctrl+Z)"
                            aria-label="Undo"
                        >
                            <span className="toolbar-button-icon"><Undo2 size={20} /></span>
                        </button>
                        <button
                            className="toolbar-button"
                            onClick={handleRedo}
                            title="Redo (Ctrl+Y)"
                            aria-label="Redo"
                        >
                            <span className="toolbar-button-icon"><Redo2 size={20} /></span>
                        </button>
                    </div>

                    <div className="toolbar-divider" />

                    {/* Headings Group */}
                    <div className="toolbar-group" aria-label="Headings">
                        <button
                            className="toolbar-button"
                            onClick={() => insertHeading(1)}
                            title="Heading 1 (Ctrl+Alt+1)"
                            aria-label="Insert Heading 1"
                        >
                            <span className="toolbar-button-icon"><Heading1 size={20} /></span>
                        </button>
                        <button
                            className="toolbar-button"
                            onClick={() => insertHeading(2)}
                            title="Heading 2 (Ctrl+Alt+2)"
                            aria-label="Insert Heading 2"
                        >
                            <span className="toolbar-button-icon"><Heading2 size={20} /></span>
                        </button>
                        <button
                            className="toolbar-button"
                            onClick={() => insertHeading(3)}
                            title="Heading 3 (Ctrl+Alt+3)"
                            aria-label="Insert Heading 3"
                        >
                            <span className="toolbar-button-icon"><Heading3 size={20} /></span>
                        </button>
                        <button
                            className="toolbar-button"
                            onClick={clearHeading}
                            title="Paragraph (Ctrl+Alt+0)"
                            aria-label="Clear Heading Formatting"
                        >
                            <span className="toolbar-button-icon"><Pilcrow size={20} /></span>
                        </button>
                    </div>

                    <div className="toolbar-divider" />

                    {/* Text Formatting Group */}
                    <div className="toolbar-group" aria-label="Text Formatting">
                        <button
                            className="toolbar-button"
                            onClick={toggleBold}
                            title="Bold (Ctrl+B)"
                            aria-label="Toggle Bold"
                        >
                            <span className="toolbar-button-icon"><Bold size={20} /></span>
                        </button>
                        <button
                            className="toolbar-button"
                            onClick={toggleItalic}
                            title="Italic (Ctrl+I)"
                            aria-label="Toggle Italic"
                        >
                            <span className="toolbar-button-icon"><Italic size={20} /></span>
                        </button>
                        <button
                            className="toolbar-button"
                            onClick={toggleStrikethrough}
                            title="Strikethrough"
                            aria-label="Toggle Strikethrough"
                        >
                            <span className="toolbar-button-icon"><Strikethrough size={20} /></span>
                        </button>
                    </div>

                    <div className="toolbar-divider" />

                    {/* Insert Group */}
                    <div className="toolbar-group" aria-label="Insert">
                        <div className="toolbar-dropdown-container">
                            <button
                                className={`toolbar-button ${activePopover === 'link' ? 'active' : ''}`}
                                onClick={openLinkPopover}
                                title="Insert Link"
                                aria-label="Insert Link"
                                aria-expanded={activePopover === 'link'}
                            >
                                <span className="toolbar-button-icon"><Link size={20} /></span>
                            </button>
                            {activePopover === 'link' && (
                                <div className="toolbar-dropdown popover" role="dialog" aria-label="Insert Link">
                                    <div className="dropdown-section-header">Insert Link</div>
                                    <input
                                        className="popover-input"
                                        type="text"
                                        value={linkUrl}
                                        onChange={(e) => { setLinkUrl(e.target.value); setLinkError(null); }}
                                        onKeyDown={(e) => { if (e.key === 'Enter') handleInsertLink(); }}
                                        placeholder="https://example.com"
                                        aria-label="Link URL"
                                        autoFocus
                                    />
                                    <input
                                        className="popover-input"
                                        type="text"
                                        value={linkText}
                                        onChange={(e) => setLinkText(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') handleInsertLink(); }}
                                        placeholder="Link text (optional)"
                                        aria-label="Link display text"
                                    />
                                    {linkError && <div className="popover-error">{linkError}</div>}
                                    <div className="popover-actions">
                                        <button className="popover-submit" onClick={handleInsertLink}>Insert</button>
                                    </div>
                                </div>
                            )}
                        </div>
                        <div className="toolbar-dropdown-container">
                            <button
                                className={`toolbar-button ${activePopover === 'image' ? 'active' : ''}`}
                                onClick={openImagePopover}
                                title="Insert Image"
                                aria-label="Insert Image"
                                aria-expanded={activePopover === 'image'}
                            >
                                <span className="toolbar-button-icon"><Image size={20} /></span>
                            </button>
                            {activePopover === 'image' && (
                                <div className="toolbar-dropdown popover" role="dialog" aria-label="Insert Image">
                                    <div className="dropdown-section-header">Insert Image</div>
                                    <input
                                        className="popover-input"
                                        type="text"
                                        value={imageUrl}
                                        onChange={(e) => { setImageUrl(e.target.value); setImageError(null); }}
                                        onKeyDown={(e) => { if (e.key === 'Enter') handleInsertImage(); }}
                                        placeholder="https://example.com/image.png"
                                        aria-label="Image URL"
                                        autoFocus
                                    />
                                    <input
                                        className="popover-input"
                                        type="text"
                                        value={imageAlt}
                                        onChange={(e) => setImageAlt(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') handleInsertImage(); }}
                                        placeholder="Alt text (optional)"
                                        aria-label="Image alt text"
                                    />
                                    {imageError && <div className="popover-error">{imageError}</div>}
                                    <div className="popover-actions">
                                        <button className="popover-submit" onClick={handleInsertImage}>Insert</button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="toolbar-divider" />

                    {/* Lists Group */}
                    <div className="toolbar-group" aria-label="Lists">
                        <button
                            className="toolbar-button"
                            onClick={insertBulletList}
                            title="Bullet List"
                            aria-label="Insert Bullet List"
                        >
                            <span className="toolbar-button-icon"><List size={20} /></span>
                        </button>
                        <button
                            className="toolbar-button"
                            onClick={insertOrderedList}
                            title="Numbered List"
                            aria-label="Insert Numbered List"
                        >
                            <span className="toolbar-button-icon"><ListOrdered size={20} /></span>
                        </button>
                    </div>

                    <div className="toolbar-divider" />

                    {/* Blocks Group */}
                    <div className="toolbar-group" aria-label="Blocks">
                        <button
                            className="toolbar-button"
                            onClick={insertCode}
                            title="Code Block"
                            aria-label="Insert Code Block"
                        >
                            <span className="toolbar-button-icon"><Code size={20} /></span>
                        </button>
                        <div className="toolbar-dropdown-container">
                            <button
                                className={`toolbar-button toolbar-dropdown-trigger ${showTablePicker ? 'active' : ''}`}
                                onClick={toggleTablePicker}
                                title="Table Options"
                                aria-label="Table Options"
                                aria-expanded={showTablePicker}
                            >
                                <span className="toolbar-button-icon"><Table size={20} /></span>
                                <span className="toolbar-button-icon dropdown-chevron"><ChevronDown size={12} /></span>
                            </button>
                            {showTablePicker && (
                                <div className="toolbar-dropdown table-dropdown">
                                    <div className="dropdown-section-header">Insert New Table</div>
                                    <div className="table-size-picker">
                                        <div className="table-grid">
                                            {Array.from({ length: TABLE_GRID_SIZE }).map((_, rowIndex) => (
                                                <div key={rowIndex} className="table-grid-row">
                                                    {Array.from({ length: TABLE_GRID_SIZE }).map((_, colIndex) => (
                                                        <div
                                                            key={colIndex}
                                                            className={`table-grid-cell ${
                                                                rowIndex <= hoveredCell.row && colIndex <= hoveredCell.col
                                                                    ? 'highlighted'
                                                                    : ''
                                                            }`}
                                                            onMouseEnter={() => setHoveredCell({ row: rowIndex, col: colIndex })}
                                                            onClick={() => insertTableWithSize(rowIndex + 1, colIndex + 1)}
                                                        />
                                                    ))}
                                                </div>
                                            ))}
                                        </div>
                                        <div className="table-size-label">
                                            {Math.max(TABLE_MIN_ROWS, hoveredCell.row + 1)} × {hoveredCell.col + 1} (min {TABLE_MIN_ROWS} rows)
                                        </div>
                                    </div>
                                    <div className="dropdown-divider" />
                                    <div className="dropdown-section-header">Edit Existing Table</div>
                                    <button className="dropdown-item" onClick={addTableRow}>
                                        <span className="dropdown-icon"><Plus size={16} /></span>
                                        <span>Add Row Below</span>
                                    </button>
                                    <button className="dropdown-item" onClick={addTableColumn}>
                                        <span className="dropdown-icon"><Plus size={16} /></span>
                                        <span>Add Column Right</span>
                                    </button>
                                    <button className="dropdown-item" onClick={deleteTableRow}>
                                        <span className="dropdown-icon"><Minus size={16} /></span>
                                        <span>Delete Row</span>
                                    </button>
                                    <button className="dropdown-item" onClick={deleteTableColumn}>
                                        <span className="dropdown-icon"><Minus size={16} /></span>
                                        <span>Delete Column</span>
                                    </button>
                                    <div className="dropdown-divider" />
                                    <button className="dropdown-item dropdown-item-danger" onClick={deleteTable}>
                                        <span className="dropdown-icon"><Trash2 size={16} /></span>
                                        <span>Delete Entire Table</span>
                                    </button>
                                </div>
                            )}
                        </div>
                        <button
                            className="toolbar-button"
                            onClick={insertBlockquote}
                            title="Blockquote"
                            aria-label="Insert Blockquote"
                        >
                            <span className="toolbar-button-icon"><Quote size={20} /></span>
                        </button>
                        <button
                            className="toolbar-button"
                            onClick={insertHorizontalRule}
                            title="Horizontal Rule"
                            aria-label="Insert Horizontal Rule"
                        >
                            <span className="toolbar-button-icon"><Minus size={20} /></span>
                        </button>
                    </div>

                    <div className="toolbar-divider" />

                    {/* Actions Group */}
                    <div className="toolbar-group" aria-label="Actions">
                        <button
                            className={`toolbar-button ${copyStatus === 'copied' ? 'copy-success' : ''}`}
                            onClick={copyToClipboard}
                            title="Copy to Clipboard"
                            aria-label="Copy markdown to clipboard"
                        >
                            <span className="toolbar-button-icon">
                                {copyStatus === 'copied' ? <Check size={20} /> : <Copy size={20} />}
                            </span>
                        </button>
                    </div>
                </div>
            )}

            <div className="markdown-editor-wrapper">
                {editorError ? (
                    <div className="markdown-editor-error">
                        <h3>Editor Error</h3>
                        <p>{editorError}</p>
                        <p>Check the browser console for more details.</p>
                    </div>
                ) : (
                    <>
                        {loading && (
                            <div className="markdown-editor-loading" style={{ position: 'absolute', zIndex: 10, background: 'rgba(255,255,255,0.9)', padding: '20px', borderRadius: '4px' }}>
                                <p>Loading Milkdown editor...</p>
                                <p style={{ fontSize: '11px', color: '#999', marginTop: '8px' }}>
                                    Initializing... Check console if this persists.
                                </p>
                            </div>
                        )}
                        <Milkdown />
                    </>
                )}
            </div>

            {!readOnly && (
                <div className="markdown-status-bar">
                    <div className="status-item">
                        <span ref={wordCountElRef} className="status-metric">Words: {wordCountRef.current}</span>
                        <span className="status-separator">|</span>
                        <span ref={charCountElRef} className="status-metric">Characters: {charCountRef.current} / {maxLength}</span>
                    </div>
                </div>
            )}
        </div>
    );
};

// Memoized wrapper to prevent unnecessary re-renders when parent re-renders with same props
export const MarkdownEditor: React.FC<MarkdownEditorProps> = React.memo((props) => {
    return (
        <MilkdownProvider>
            <EditorComponent
                value={props.value}
                onUpdate={props.onChange}
                readOnly={props.readOnly}
                showToolbar={props.showToolbar}
                enableSpellCheck={props.enableSpellCheck}
                maxLength={props.maxLength}
                height={props.height}
                width={props.width}
                toolbarSize={props.toolbarSize}
            />
        </MilkdownProvider>
    );
}, (prev, next) => {
    // Custom comparison - only re-render when these props actually change
    return (
        prev.value === next.value &&
        prev.readOnly === next.readOnly &&
        prev.showToolbar === next.showToolbar &&
        prev.enableSpellCheck === next.enableSpellCheck &&
        prev.maxLength === next.maxLength &&
        prev.height === next.height &&
        prev.width === next.width &&
        prev.toolbarSize === next.toolbarSize
        // onChange is bound once in PCF constructor, always same reference
    );
});
