import { useCallback } from 'react';
import { Editor, editorViewCtx } from '@milkdown/core';
import { callCommand } from '@milkdown/utils';
import {
    toggleStrongCommand,
    toggleEmphasisCommand,
    wrapInHeadingCommand,
    wrapInBulletListCommand,
    wrapInOrderedListCommand,
    wrapInBlockquoteCommand,
    insertHrCommand
} from '@milkdown/preset-commonmark';
import { insertTableCommand, toggleStrikethroughCommand } from '@milkdown/preset-gfm';
import { redoCommand, undoCommand } from '@milkdown/plugin-history';
import { handleError } from '../utils/errorHandler';
import { TABLE_MIN_ROWS } from '../utils/constants';

export interface UseEditorCommandsProps {
    getEditor: () => Editor | undefined;
}

export interface EditorCommands {
    executeCommand: (command: Parameters<typeof callCommand>[0], payload?: unknown) => void;
    insertHeading: (level: number) => void;
    clearHeading: () => void;
    toggleBold: () => void;
    toggleItalic: () => void;
    toggleStrikethrough: () => void;
    handleUndo: () => void;
    handleRedo: () => void;
    insertBlockquote: () => void;
    insertHorizontalRule: () => void;
    insertBulletList: () => void;
    insertOrderedList: () => void;
    insertCode: () => void;
    insertTable: (rows: number, cols: number) => void;
}

export function useEditorCommands({ getEditor }: UseEditorCommandsProps): EditorCommands {
    // Centralizes focus return (Decision item E): every toolbar command that goes through
    // executeCommand refocuses the ProseMirror view afterward, so the caret stays visible and
    // usable instead of being left on the toolbar button that was clicked.
    const executeCommand = useCallback((command: Parameters<typeof callCommand>[0], payload?: unknown) => {
        try {
            const editor = getEditor();
            editor?.action(callCommand(command, payload));
            const view = editor?.ctx.get(editorViewCtx);
            view?.focus();
        } catch (error) {
            handleError(error, { component: 'useEditorCommands', action: 'executeCommand' });
        }
    }, [getEditor]);

    const insertHeading = useCallback((level: number) => {
        executeCommand(wrapInHeadingCommand.key, level);
    }, [executeCommand]);

    const clearHeading = useCallback(() => {
        executeCommand(wrapInHeadingCommand.key, 0);
    }, [executeCommand]);

    const toggleBold = useCallback(() => {
        executeCommand(toggleStrongCommand.key);
    }, [executeCommand]);

    const toggleItalic = useCallback(() => {
        executeCommand(toggleEmphasisCommand.key);
    }, [executeCommand]);

    const toggleStrikethrough = useCallback(() => {
        executeCommand(toggleStrikethroughCommand.key);
    }, [executeCommand]);

    const handleUndo = useCallback(() => {
        executeCommand(undoCommand.key);
    }, [executeCommand]);

    const handleRedo = useCallback(() => {
        executeCommand(redoCommand.key);
    }, [executeCommand]);

    const insertBlockquote = useCallback(() => {
        executeCommand(wrapInBlockquoteCommand.key);
    }, [executeCommand]);

    const insertHorizontalRule = useCallback(() => {
        executeCommand(insertHrCommand.key);
    }, [executeCommand]);

    const insertBulletList = useCallback(() => {
        executeCommand(wrapInBulletListCommand.key);
    }, [executeCommand]);

    const insertOrderedList = useCallback(() => {
        executeCommand(wrapInOrderedListCommand.key);
    }, [executeCommand]);

    const insertCode = useCallback(() => {
        const editor = getEditor();
        if (!editor) return;

        try {
            const view = editor.ctx.get(editorViewCtx);
            if (view) {
                const { state, dispatch } = view;
                const codeBlockType = state.schema.nodes.code_block;
                if (codeBlockType) {
                    const codeBlock = codeBlockType.create(
                        { language: '' },
                        state.schema.text('// code here')
                    );
                    const tr = state.tr.replaceSelectionWith(codeBlock);
                    dispatch(tr);
                    view.focus();
                }
            }
        } catch (error) {
            handleError(error, { component: 'useEditorCommands', action: 'insertCode' });
        }
    }, [getEditor]);

    const insertTable = useCallback((rows: number, cols: number) => {
        const actualRows = Math.max(TABLE_MIN_ROWS, rows);
        if (actualRows > 0 && cols > 0) {
            executeCommand(insertTableCommand.key, { row: actualRows, col: cols });
        }
    }, [executeCommand]);

    return {
        executeCommand,
        insertHeading,
        clearHeading,
        toggleBold,
        toggleItalic,
        toggleStrikethrough,
        handleUndo,
        handleRedo,
        insertBlockquote,
        insertHorizontalRule,
        insertBulletList,
        insertOrderedList,
        insertCode,
        insertTable
    };
}
