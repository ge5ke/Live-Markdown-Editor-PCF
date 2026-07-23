import { useCallback } from 'react';
import { Editor, editorViewCtx } from '@milkdown/core';
import { Node as ProseMirrorNode } from '@milkdown/prose/model';
import { handleError } from '../utils/errorHandler';
import { TABLE_MIN_ROWS, TABLE_MIN_COLS } from '../utils/constants';

export type NotificationType = 'info' | 'warning' | 'error';

export interface UseTableOperationsProps {
    getEditor: () => Editor | undefined;
    onComplete?: () => void;
    onNotify?: (message: string, type: NotificationType) => void;
}

export interface TableOperations {
    addTableRow: () => void;
    addTableColumn: () => void;
    deleteTableRow: () => void;
    deleteTableColumn: () => void;
    deleteTable: () => void;
}

// Helper to create an empty cell with proper content structure
function createEmptyCell(
    state: { schema: { nodes: Record<string, { create: (attrs: null, content?: ProseMirrorNode | ProseMirrorNode[]) => ProseMirrorNode } | undefined> } },
    cellTypeName: string
): ProseMirrorNode | null {
    const cellType = state.schema.nodes[cellTypeName];
    const paragraphType = state.schema.nodes.paragraph;
    if (!cellType) return null;

    if (paragraphType) {
        const emptyParagraph = paragraphType.create(null);
        return cellType.create(null, emptyParagraph);
    }
    return cellType.create(null);
}

// Helper to show notification with fallback to alert
function notify(
    onNotify: UseTableOperationsProps['onNotify'],
    message: string,
    type: NotificationType = 'info'
): void {
    if (onNotify) {
        onNotify(message, type);
    } else {
        // Fallback to alert for backwards compatibility
        window.alert(message);
    }
}

export function useTableOperations({ getEditor, onComplete, onNotify }: UseTableOperationsProps): TableOperations {
    const addTableRow = useCallback(() => {
        const editor = getEditor();
        if (!editor) return;

        try {
            const view = editor.ctx.get(editorViewCtx);
            if (!view) return;

            const { state, dispatch } = view;
            const { selection } = state;
            const $from = selection.$from;

            let tableDepth = -1;
            let tableNode: ProseMirrorNode | null = null;
            let rowIndex = -1;

            for (let depth = $from.depth; depth >= 0; depth--) {
                const node = $from.node(depth);
                if (node.type.name === 'table') {
                    tableDepth = depth;
                    tableNode = node;
                    for (let d = $from.depth; d > depth; d--) {
                        const n = $from.node(d);
                        if (n.type.name === 'table_row') {
                            rowIndex = $from.index(d - 1);
                            break;
                        }
                    }
                    break;
                }
            }

            if (tableDepth === -1 || !tableNode || rowIndex === -1) {
                notify(onNotify, 'Place your cursor inside a table to add a row.', 'info');
                return;
            }

            const firstRow = tableNode.firstChild;
            if (!firstRow) return;
            const numCols = firstRow.childCount;

            const cells: ProseMirrorNode[] = [];
            for (let i = 0; i < numCols; i++) {
                const newCell = createEmptyCell(state, 'table_cell');
                if (newCell) cells.push(newCell);
            }

            if (cells.length === 0) return;

            const tableRowType = state.schema.nodes.table_row;
            if (!tableRowType) return;

            const newRow = tableRowType.create(null, cells);
            const tableStart = $from.before(tableDepth);
            let insertPos = tableStart + 1;

            for (let i = 0; i <= rowIndex; i++) {
                const row = tableNode.child(i);
                insertPos += row.nodeSize;
            }

            const tr = state.tr.insert(insertPos, newRow);
            dispatch(tr);
            view.focus();
            onComplete?.();
        } catch (error) {
            handleError(error, { component: 'useTableOperations', action: 'addTableRow' });
        }
    }, [getEditor, onComplete, onNotify]);

    const addTableColumn = useCallback(() => {
        const editor = getEditor();
        if (!editor) return;

        try {
            const view = editor.ctx.get(editorViewCtx);
            if (!view) return;

            const { state, dispatch } = view;
            const { selection } = state;
            const $from = selection.$from;

            let tableDepth = -1;
            let tableNode: ProseMirrorNode | null = null;
            let colIndex = 0;

            for (let depth = $from.depth; depth >= 0; depth--) {
                const node = $from.node(depth);
                if (node.type.name === 'table') {
                    tableDepth = depth;
                    tableNode = node;
                    break;
                }
                if (node.type.name === 'table_cell' || node.type.name === 'table_header') {
                    colIndex = $from.index(depth - 1);
                }
            }

            if (tableDepth === -1 || !tableNode) {
                notify(onNotify, 'Place your cursor inside a table to add a column.', 'info');
                return;
            }

            const tableStart = $from.before(tableDepth);
            const tableRowType = state.schema.nodes.table_row;
            const tableType = state.schema.nodes.table;
            if (!tableRowType || !tableType) return;

            const newRows: ProseMirrorNode[] = [];
            let isFirstRow = true;

            tableNode.forEach((row) => {
                const newCells: ProseMirrorNode[] = [];
                let cellIdx = 0;

                row.forEach((cell) => {
                    newCells.push(cell.copy(cell.content));

                    if (cellIdx === colIndex) {
                        const cellTypeName = isFirstRow ? 'table_header' : 'table_cell';
                        let newCell = createEmptyCell(state, cellTypeName);
                        if (!newCell) {
                            newCell = createEmptyCell(state, 'table_cell');
                        }
                        if (newCell) newCells.push(newCell);
                    }
                    cellIdx++;
                });

                const newRow = tableRowType.create(null, newCells);
                newRows.push(newRow);
                isFirstRow = false;
            });

            const newTable = tableType.create(tableNode.attrs, newRows);
            const tableEnd = $from.after(tableDepth);
            const tr = state.tr.replaceWith(tableStart, tableEnd, newTable);
            dispatch(tr);
            view.focus();
            onComplete?.();
        } catch (error) {
            handleError(error, { component: 'useTableOperations', action: 'addTableColumn' });
        }
    }, [getEditor, onComplete, onNotify]);

    const deleteTableRow = useCallback(() => {
        const editor = getEditor();
        if (!editor) return;

        try {
            const view = editor.ctx.get(editorViewCtx);
            if (!view) return;

            const { state, dispatch } = view;
            const { selection } = state;
            const $from = selection.$from;

            let tableNode: ProseMirrorNode | null = null;
            for (let depth = $from.depth; depth >= 0; depth--) {
                const node = $from.node(depth);
                if (node.type.name === 'table') {
                    tableNode = node;
                    break;
                }
            }

            if (tableNode && tableNode.childCount <= TABLE_MIN_ROWS) {
                notify(onNotify, 'Cannot delete row - tables need at least 2 rows (header + data). Delete the table instead.', 'warning');
                onComplete?.();
                return;
            }

            for (let depth = $from.depth; depth >= 0; depth--) {
                const node = $from.node(depth);
                if (node.type.name === 'table_row') {
                    const start = $from.before(depth);
                    const end = $from.after(depth);
                    const tr = state.tr.delete(start, end);
                    dispatch(tr);
                    view.focus();
                    onComplete?.();
                    return;
                }
            }
            notify(onNotify, 'Place your cursor inside a table row to delete it.', 'info');
        } catch (error) {
            handleError(error, { component: 'useTableOperations', action: 'deleteTableRow' });
        }
        onComplete?.();
    }, [getEditor, onComplete, onNotify]);

    const deleteTableColumn = useCallback(() => {
        const editor = getEditor();
        if (!editor) return;

        try {
            const view = editor.ctx.get(editorViewCtx);
            if (!view) return;

            const { state, dispatch } = view;
            const { selection } = state;
            const $from = selection.$from;

            let tableDepth = -1;
            let tableNode: ProseMirrorNode | null = null;
            let currentColIndex = 0;

            for (let depth = $from.depth; depth >= 0; depth--) {
                const node = $from.node(depth);
                if (node.type.name === 'table') {
                    tableDepth = depth;
                    tableNode = node;
                    break;
                }
                if (node.type.name === 'table_cell' || node.type.name === 'table_header') {
                    currentColIndex = $from.index(depth - 1);
                }
            }

            if (tableDepth === -1 || !tableNode) {
                notify(onNotify, 'Place your cursor inside a table to delete a column.', 'info');
                onComplete?.();
                return;
            }

            const tableStart = $from.before(tableDepth);
            const firstRow = tableNode.firstChild;
            if (firstRow && firstRow.childCount <= TABLE_MIN_COLS) {
                notify(onNotify, 'Cannot delete the last column. Delete the table instead.', 'warning');
                onComplete?.();
                return;
            }

            const tableRowType = state.schema.nodes.table_row;
            const tableType = state.schema.nodes.table;
            if (!tableRowType || !tableType) return;

            const newRows: ProseMirrorNode[] = [];
            tableNode.forEach((row) => {
                const newCells: ProseMirrorNode[] = [];
                let cellIdx = 0;
                row.forEach((cell) => {
                    if (cellIdx !== currentColIndex) {
                        newCells.push(cell.copy(cell.content));
                    }
                    cellIdx++;
                });
                const newRow = tableRowType.create(null, newCells);
                newRows.push(newRow);
            });

            const newTable = tableType.create(tableNode.attrs, newRows);
            const tableEnd = $from.after(tableDepth);
            const tr = state.tr.replaceWith(tableStart, tableEnd, newTable);
            dispatch(tr);
            view.focus();
            onComplete?.();
        } catch (error) {
            handleError(error, { component: 'useTableOperations', action: 'deleteTableColumn' });
        }
    }, [getEditor, onComplete, onNotify]);

    const deleteTable = useCallback(() => {
        const editor = getEditor();
        if (!editor) return;

        try {
            const view = editor.ctx.get(editorViewCtx);
            if (!view) return;

            const { state, dispatch } = view;
            const { selection } = state;
            const pos = selection.$from;

            for (let depth = pos.depth; depth >= 0; depth--) {
                const node = pos.node(depth);
                if (node.type.name === 'table') {
                    const start = pos.before(depth);
                    const end = pos.after(depth);
                    const tr = state.tr.delete(start, end);
                    dispatch(tr);
                    view.focus();
                    onComplete?.();
                    return;
                }
            }
            notify(onNotify, 'Place your cursor inside a table to delete it.', 'info');
        } catch (error) {
            handleError(error, { component: 'useTableOperations', action: 'deleteTable' });
        }
        onComplete?.();
    }, [getEditor, onComplete, onNotify]);

    return {
        addTableRow,
        addTableColumn,
        deleteTableRow,
        deleteTableColumn,
        deleteTable
    };
}
