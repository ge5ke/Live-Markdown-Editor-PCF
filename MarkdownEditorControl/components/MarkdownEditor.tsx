import * as React from 'react';
import { useEffect, useState, useCallback, useRef } from 'react';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { nord } from '@milkdown/theme-nord';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, parserCtx, serializerCtx } from '@milkdown/core';
import { insertImageCommand } from '@milkdown/preset-commonmark';
import { history } from '@milkdown/plugin-history';
import '@milkdown/theme-nord/style.css';

// Import security utilities
import { validateImageSize } from '../utils/security';
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

export interface MarkdownEditorProps {
    value: string;
    onChange: (value: string) => void;
    readOnly?: boolean;
    showToolbar?: boolean;
    enableSpellCheck?: boolean;
    maxLength?: number;
    height?: number;
    width?: number;
    toolbarSize?: 'sm' | 'md' | 'lg';
}

const EditorComponent: React.FC<Omit<MarkdownEditorProps, 'value' | 'onChange'> & {
    onUpdate: (markdown: string) => void;
    initialValue: string;
}> = ({
    initialValue,
    onUpdate,
    readOnly = false,
    showToolbar = true,
    maxLength = 100000,
    height,
    width,
    toolbarSize = 'md'
}) => {
    // Use refs instead of state for stats to avoid re-renders on every keystroke
    const wordCountRef = useRef(0);
    const charCountRef = useRef(0);
    const [editorError, setEditorError] = useState<string | null>(null);
    const [copyStatus, setCopyStatus] = useState<'idle' | 'copied'>('idle');
    const [showTablePicker, setShowTablePicker] = useState(false);
    const [tableSize, setTableSize] = useState<{ rows: number; cols: number }>({ rows: 3, cols: 3 });
    const [hoveredCell, setHoveredCell] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
    const editorRef = useRef<Editor | null>(null);
    const currentMarkdownRef = useRef<string>(initialValue);
    const serializeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const focusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const getEditorRef = useRef<(() => Editor | undefined) | undefined>(undefined);

    // Cleanup timeouts on unmount
    useEffect(() => {
        return () => {
            if (serializeTimeoutRef.current) clearTimeout(serializeTimeoutRef.current);
            if (focusTimeoutRef.current) clearTimeout(focusTimeoutRef.current);
        };
    }, []);

    // Calculate statistics (optimized - uses refs + direct DOM updates to avoid re-renders)
    const updateStats = useCallback((text: string) => {
        const chars = text.length;
        const wordMatches = text.match(WORD_MATCH_REGEX);
        const words = wordMatches ? wordMatches.length : 0;

        // Update refs (no re-render)
        wordCountRef.current = words;
        charCountRef.current = chars;

        // Update DOM directly for instant feedback without re-render
        const wordEl = document.getElementById('md-word-count');
        const charEl = document.getElementById('md-char-count');
        if (wordEl) wordEl.textContent = `Words: ${words}`;
        if (charEl) charEl.textContent = `Characters: ${chars} / ${maxLength}`;
    }, [maxLength]);

    // Initialize Milkdown editor using React hooks following v7 pattern
    const { loading, get } = useEditor((root) => {
        try {
            const editor = Editor
                .make()
                .config(nord)
                .config((ctx) => {
                    ctx.set(rootCtx, root);
                    ctx.set(defaultValueCtx, initialValue);
                })
                .config((ctx) => {
                    const listenerPlugin = ctx.get(listenerCtx);
                    // ULTRA-MINIMAL keystroke handler - do almost nothing synchronously
                    // All expensive work is deferred to prevent ANY typing lag
                    listenerPlugin.updated((_ctx, doc) => {
                        // Clear existing timeout and set new one - this is the ONLY sync work
                        if (serializeTimeoutRef.current) {
                            clearTimeout(serializeTimeoutRef.current);
                        }

                        // Defer ALL work to after typing stops
                        serializeTimeoutRef.current = setTimeout(() => {
                            try {
                                // Serialize to markdown
                                const serializer = ctx.get(serializerCtx);
                                const markdown = serializer(doc);
                                currentMarkdownRef.current = markdown;

                                // Update parent
                                onUpdate(markdown);

                                // Update stats
                                const charCount = doc.textContent.length;
                                const wordMatches = markdown.match(WORD_MATCH_REGEX);
                                const words = wordMatches ? wordMatches.length : 0;

                                charCountRef.current = charCount;
                                wordCountRef.current = words;

                                // Direct DOM updates (no React re-render)
                                const wordEl = document.getElementById('md-word-count');
                                const charEl = document.getElementById('md-char-count');
                                if (wordEl) wordEl.textContent = `Words: ${words}`;
                                if (charEl) charEl.textContent = `Characters: ${charCount} / ${maxLength}`;
                            } catch (error) {
                                handleError(error, { component: 'MarkdownEditor', action: 'serialize' });
                            }
                        }, DEBOUNCE_SERIALIZE_MS);
                    });
                })
                .use(commonmark)
                .use(gfm)
                .use(history)
                .use(listener);

            editorRef.current = editor;
            return editor;
        } catch (error) {
            setEditorError(error instanceof Error ? error.message : 'Unknown error');
            throw error;
        }
    }, []);

    // Update stats when value changes
    useEffect(() => {
        updateStats(initialValue);
    }, [initialValue, updateStats]);

    // Sync stable editor reference for use in callbacks
    useEffect(() => {
        getEditorRef.current = get;
    }, [get]);

    // Stable getEditor function for hooks
    const getEditor = useCallback(() => get?.(), [get]);

    // Use extracted hooks for editor commands
    const editorCommands = useEditorCommands({ getEditor });

    // Use extracted hooks for table operations
    const tableOperations = useTableOperations({
        getEditor,
        onComplete: () => setShowTablePicker(false)
    });

    // Sync editor content when initialValue prop changes (handles late-arriving Dataverse data)
    // Only updates if editor is empty and new value has content
    useEffect(() => {
        const editor = get?.();
        if (!editor || !initialValue) return;

        // Only sync if editor is currently empty but props have content
        const currentContent = currentMarkdownRef.current;
        if (currentContent && currentContent.trim() !== '') return; // Don't overwrite existing content

        try {
            const view = editor.ctx.get(editorViewCtx);
            const parser = editor.ctx.get(parserCtx);

            if (view && parser) {
                const doc = parser(initialValue);
                if (doc) {
                    const { state, dispatch } = view;
                    const tr = state.tr.replaceWith(0, state.doc.content.size, doc.content);
                    dispatch(tr);
                    currentMarkdownRef.current = initialValue;
                }
            }
        } catch (error) {
            handleError(error, { component: 'MarkdownEditor', action: 'syncInitialValue' });
        }
    }, [initialValue, get]);

    // Destructure commands from hook for cleaner JSX usage
    const {
        insertHeading, clearHeading, toggleBold, toggleItalic, toggleStrikethrough,
        handleUndo, handleRedo, insertBlockquote, insertHorizontalRule,
        insertBulletList, insertOrderedList, insertLink, insertImage, insertCode,
        insertTable: insertTableCommand_fn, executeCommand
    } = editorCommands;

    // Destructure table operations from hook
    const { addTableRow, addTableColumn, deleteTableRow, deleteTableColumn, deleteTable } = tableOperations;

    // Toggle table picker visibility
    const toggleTablePicker = () => {
        setShowTablePicker(!showTablePicker);
        setHoveredCell({ row: 0, col: 0 });
    };

    // Insert table with specified dimensions (minimum 2 rows to have header + data)
    const insertTableWithSize = (rows: number, cols: number) => {
        insertTableCommand_fn(rows, cols);
        setShowTablePicker(false);
        setHoveredCell({ row: 0, col: 0 });
    };

    const copyToClipboard = async () => {
        try {
            await navigator.clipboard.writeText(currentMarkdownRef.current);
            setCopyStatus('copied');
            setTimeout(() => setCopyStatus('idle'), COPY_SUCCESS_TIMEOUT_MS);
        } catch (error) {
            handleError(error, { component: 'MarkdownEditor', action: 'copyToClipboard' }, 'warning');
        }
    };

    // Close dropdowns when clicking outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setShowTablePicker(false);
            }
        };
        if (showTablePicker) {
            document.addEventListener('mousedown', handleClickOutside);
            return () => document.removeEventListener('mousedown', handleClickOutside);
        }
    }, [showTablePicker]);

    // Helper function to detect if text looks like markdown
    const looksLikeMarkdown = (text: string): boolean => {
        // Check for common markdown patterns
        const markdownPatterns = [
            /^#{1,6}\s+/m,           // Headers: # Header
            /\*\*[^*]+\*\*/,         // Bold: **text**
            /\*[^*]+\*/,             // Italic: *text*
            /^\s*[-*+]\s+/m,         // Unordered lists: - item
            /^\s*\d+\.\s+/m,         // Ordered lists: 1. item
            /\[.+\]\(.+\)/,          // Links: [text](url)
            /!\[.*\]\(.+\)/,         // Images: ![alt](url)
            /```[\s\S]*```/,         // Code blocks: ```code```
            /`[^`]+`/,               // Inline code: `code`
            /^\|.+\|$/m,             // Tables: | cell |
            /^>\s+/m,                // Blockquotes: > quote
            /^---$/m,                // Horizontal rules
            /~~[^~]+~~/,             // Strikethrough: ~~text~~
            /^\s*-\s*\[[ x]\]/m,     // Task lists: - [ ] or - [x]
        ];

        // Count how many patterns match
        let matchCount = 0;
        for (const pattern of markdownPatterns) {
            if (pattern.test(text)) {
                matchCount++;
            }
        }

        // Consider it markdown if at least 2 patterns match, or if it has headers/code blocks
        return matchCount >= 2 || /^#{1,6}\s+/m.test(text) || /```[\s\S]*```/.test(text);
    };

    // Handle paste events for images and markdown
    const handlePaste = useCallback((e: Event) => {
        const clipboardEvent = e as ClipboardEvent;
        const items = clipboardEvent.clipboardData?.items;
        if (!items) return;

        const itemsArray = Array.from(items);

        // First, check for images
        for (const item of itemsArray) {
            if (item.type.startsWith('image/')) {
                // Stop the event completely to prevent double paste
                e.preventDefault();
                e.stopPropagation();

                const file = item.getAsFile();
                if (!file) continue;

                // Validate image size
                const sizeValidation = validateImageSize(file);
                if (!sizeValidation.valid) {
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
        }

        // Check for text that looks like markdown
        const textData = clipboardEvent.clipboardData?.getData('text/plain');
        if (textData && looksLikeMarkdown(textData)) {
            e.preventDefault();

            try {
                const editor = get?.();
                if (!editor) return;

                const view = editor.ctx.get(editorViewCtx);
                const parser = editor.ctx.get(parserCtx);

                if (view && parser) {
                    const { state, dispatch } = view;

                    // Check if editor is empty or nearly empty
                    const currentContent = currentMarkdownRef.current.trim();
                    const isEmptyOrMinimal = currentContent === '' || currentContent.length < 10;

                    // Parse the markdown into a ProseMirror document
                    const doc = parser(textData);

                    if (doc) {
                        if (isEmptyOrMinimal) {
                            // Replace entire document content for empty editors
                            const tr = state.tr.replaceWith(0, state.doc.content.size, doc.content);
                            dispatch(tr);
                        } else {
                            // For non-empty editors, try to insert at cursor
                            // First, check if we're at the start of a block
                            const { $from } = state.selection;
                            const atBlockStart = $from.parentOffset === 0;

                            if (atBlockStart && doc.content.childCount > 0) {
                                // Insert block content properly
                                const { from, to } = state.selection;
                                const tr = state.tr.replaceWith(from, to, doc.content);
                                dispatch(tr);
                            } else {
                                // Insert as text slice with proper handling
                                const { from, to } = state.selection;
                                const tr = state.tr.replaceWith(from, to, doc.content);
                                dispatch(tr);
                            }
                        }
                    }
                }
            } catch (error) {
                handleError(error, { component: 'MarkdownEditor', action: 'pasteMarkdown' }, 'warning');
                // If parsing fails, let default paste behavior handle it
            }
        }
    }, [executeCommand, get]);

    // Attach paste handler to editor (capture phase to intercept before ProseMirror)
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        // Use capture phase to handle paste before ProseMirror does
        container.addEventListener('paste', handlePaste, true);
        return () => container.removeEventListener('paste', handlePaste, true);
    }, [handlePaste]);

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
                            title="Strikethrough (Ctrl+Shift+S)"
                            aria-label="Toggle Strikethrough"
                        >
                            <span className="toolbar-button-icon"><Strikethrough size={20} /></span>
                        </button>
                    </div>

                    <div className="toolbar-divider" />

                    {/* Insert Group */}
                    <div className="toolbar-group" aria-label="Insert">
                        <button
                            className="toolbar-button"
                            onClick={insertLink}
                            title="Insert Link (Ctrl+K)"
                            aria-label="Insert Link"
                        >
                            <span className="toolbar-button-icon"><Link size={20} /></span>
                        </button>
                        <button
                            className="toolbar-button"
                            onClick={insertImage}
                            title="Insert Image"
                            aria-label="Insert Image"
                        >
                            <span className="toolbar-button-icon"><Image size={20} /></span>
                        </button>
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

            <div className="markdown-status-bar">
                <div className="status-item">
                    <span id="md-word-count" className="status-metric">Words: {wordCountRef.current}</span>
                    <span className="status-separator">|</span>
                    <span id="md-char-count" className="status-metric">Characters: {charCountRef.current} / {maxLength}</span>
                </div>
                {readOnly && (
                    <div className="status-item status-readonly">
                        <span>Read Only</span>
                    </div>
                )}
            </div>
        </div>
    );
};

// Memoized wrapper to prevent unnecessary re-renders when parent re-renders with same props
export const MarkdownEditor: React.FC<MarkdownEditorProps> = React.memo((props) => {
    return (
        <MilkdownProvider>
            <EditorComponent
                initialValue={props.value}
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
