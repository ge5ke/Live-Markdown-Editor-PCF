import { Editor } from '@milkdown/core';

export interface TablePickerState {
    isOpen: boolean;
    hoveredCell: { row: number; col: number };
}

export interface EditorRefs {
    editor: React.MutableRefObject<Editor | null>;
    currentMarkdown: React.MutableRefObject<string>;
    container: React.RefObject<HTMLDivElement>;
    getEditor: React.MutableRefObject<(() => Editor | undefined) | undefined>;
}

export type EditorCommandExecutor = (
    command: Parameters<typeof import('@milkdown/utils').callCommand>[0],
    payload?: unknown
) => void;
