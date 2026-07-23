import { IInputs, IOutputs } from "./generated/ManifestTypes";
import * as React from "react";
import { createRoot, Root } from "react-dom/client";
import { MarkdownEditor } from "./components/MarkdownEditor";

interface ResolvedProps {
    readOnly: boolean;
    showToolbar: boolean;
    enableSpellCheck: boolean;
    rows: number;
    maxLength: number;
    allocatedWidth: number;
    toolbarSize: "sm" | "md" | "lg";
    editorHeightParam: number;
}

export class MarkdownEditorControl implements ComponentFramework.StandardControl<IInputs, IOutputs> {
    private _container: HTMLDivElement;
    private _notifyOutputChanged: () => void;
    private _currentValue: string;
    private _wordCount: number;
    private _characterCount: number;
    private _isValid: boolean;
    private _maxLength: number;
    private _root: Root | null;
    private _boundHandleChange: (value: string) => void;
    private _lastReadOnly: boolean;
    private _lastShowToolbar: boolean;
    private _lastEnableSpellCheck: boolean;
    private _lastRows: number;
    private _lastWidth: number;
    private _lastToolbarSize: "sm" | "md" | "lg";
    private _lastEditorHeight: number;

    constructor() {
        this._currentValue = "";
        this._wordCount = 0;
        this._characterCount = 0;
        this._isValid = true;
        this._maxLength = 100000;
        this._root = null;
        this._lastReadOnly = false;
        this._lastShowToolbar = true;
        this._lastEnableSpellCheck = true;
        this._lastRows = 10;
        this._lastWidth = 0;
        this._lastToolbarSize = "md";
        this._lastEditorHeight = 0;
        // Bind handleChange once in constructor for better performance
        this._boundHandleChange = this.handleChange.bind(this);
    }

    /**
     * Initializes the control instance.
     */
    public init(
        context: ComponentFramework.Context<IInputs>,
        notifyOutputChanged: () => void,
        _state: ComponentFramework.Dictionary,
        container: HTMLDivElement
    ): void {
        this._container = container;
        this._notifyOutputChanged = notifyOutputChanged;

        // Load initial value from bound Dataverse field
        this._currentValue = context.parameters.value?.raw ?? "";

        // Register for container resize events
        context.mode.trackContainerResize(true);

        // Capture the props this initial render uses so the first updateView
        // call correctly detects "nothing changed" instead of forcing a redundant re-render
        this.captureLastProps(context);

        // Render the React component
        this.renderComponent(context);
    }

    /**
     * Called when any value in the property bag has changed.
     */
    public updateView(context: ComponentFramework.Context<IInputs>): void {
        // Empty string is a legitimate value - only fall back to "" when raw is nullish
        const newValue = context.parameters.value?.raw ?? "";
        let needsRender = false;

        if (newValue !== this._currentValue) {
            this._currentValue = newValue;
            needsRender = true;
        }

        const props = this.computeProps(context);

        if (props.readOnly !== this._lastReadOnly) {
            this._lastReadOnly = props.readOnly;
            needsRender = true;
        }
        if (props.showToolbar !== this._lastShowToolbar) {
            this._lastShowToolbar = props.showToolbar;
            needsRender = true;
        }
        if (props.enableSpellCheck !== this._lastEnableSpellCheck) {
            this._lastEnableSpellCheck = props.enableSpellCheck;
            needsRender = true;
        }
        if (props.rows !== this._lastRows) {
            this._lastRows = props.rows;
            needsRender = true;
        }
        if (props.maxLength !== this._maxLength) {
            this._maxLength = props.maxLength;
            needsRender = true;
        }
        if (props.allocatedWidth !== this._lastWidth) {
            this._lastWidth = props.allocatedWidth;
            needsRender = true;
        }
        if (props.toolbarSize !== this._lastToolbarSize) {
            this._lastToolbarSize = props.toolbarSize;
            needsRender = true;
        }
        if (props.editorHeightParam !== this._lastEditorHeight) {
            this._lastEditorHeight = props.editorHeightParam;
            needsRender = true;
        }

        // Skip re-rendering when nothing actually changed
        if (needsRender) {
            this.renderComponent(context);
        }
    }

    /**
     * Resolves the props derived from context, shared by change-detection and rendering
     */
    private computeProps(context: ComponentFramework.Context<IInputs>): ResolvedProps {
        const readOnly = context.parameters.readOnly?.raw === true || context.mode.isControlDisabled;
        const showToolbar = context.parameters.showToolbar?.raw !== false;
        const enableSpellCheck = context.parameters.enableSpellCheck?.raw !== false;
        const rows = context.parameters.rows?.raw || 10;
        const maxLength = context.parameters.maxLength?.raw || 100000;
        const allocatedWidth = context.mode.allocatedWidth;
        const toolbarSizeParam = context.parameters.toolbarSize?.raw || "md";
        const toolbarSize = (["sm", "md", "lg"].includes(toolbarSizeParam) ? toolbarSizeParam : "md") as "sm" | "md" | "lg";
        const editorHeightParam = context.parameters.editorHeight?.raw || 0;

        return { readOnly, showToolbar, enableSpellCheck, rows, maxLength, allocatedWidth, toolbarSize, editorHeightParam };
    }

    /**
     * Stores the resolved props as the "last rendered" baseline for change detection
     */
    private captureLastProps(context: ComponentFramework.Context<IInputs>): void {
        const props = this.computeProps(context);
        this._lastReadOnly = props.readOnly;
        this._lastShowToolbar = props.showToolbar;
        this._lastEnableSpellCheck = props.enableSpellCheck;
        this._lastRows = props.rows;
        this._maxLength = props.maxLength;
        this._lastWidth = props.allocatedWidth;
        this._lastToolbarSize = props.toolbarSize;
        this._lastEditorHeight = props.editorHeightParam;
    }

    /**
     * Renders the React component
     */
    private renderComponent(context: ComponentFramework.Context<IInputs>): void {
        const { readOnly, showToolbar, enableSpellCheck, maxLength, allocatedWidth, toolbarSize, rows, editorHeightParam } =
            this.computeProps(context);

        // Calculate height: editorHeight (pixels) takes precedence over rows
        const height = editorHeightParam && editorHeightParam > 0
            ? editorHeightParam
            : rows * 54 + 50;
        const width = allocatedWidth > 0 ? allocatedWidth : undefined;

        // Create root if it doesn't exist
        if (!this._root) {
            this._root = createRoot(this._container);
        }

        // Render the component
        this._root.render(
            React.createElement(MarkdownEditor, {
                value: this._currentValue,
                onChange: this._boundHandleChange,
                readOnly: readOnly,
                showToolbar: showToolbar,
                enableSpellCheck: enableSpellCheck,
                maxLength: maxLength,
                height: height,
                width: width,
                toolbarSize: toolbarSize
            })
        );
    }

    /**
     * Handles markdown content change from the editor.
     * Only invoked on flush (blur/unmount), so eager, synchronous notification is correct.
     */
    private handleChange(value: string): void {
        this._currentValue = value;

        // Update statistics using regex (more efficient than split/filter)
        const wordMatches = value.match(/\S+/g);
        this._wordCount = wordMatches ? wordMatches.length : 0;
        this._characterCount = value.length;

        // Validate against max length
        this._isValid = this._characterCount <= this._maxLength;

        // Notify synchronously - handleChange only fires on flush (blur/unmount),
        // so there is no per-keystroke storm to debounce anymore.
        this._notifyOutputChanged();
    }

    /**
     * Returns current output values
     */
    public getOutputs(): IOutputs {
        return {
            value: this._currentValue,
            wordCount: this._wordCount,
            characterCount: this._characterCount,
            isValid: this._isValid
        };
    }

    /**
     * Cleanup when control is removed
     */
    public destroy(): void {
        if (this._root) {
            // Unmounting synchronously runs the component's cleanup effects, which
            // flush any pending edit through onUpdate -> handleChange -> notifyOutputChanged
            // before this method returns.
            this._root.unmount();
            this._root = null;
        }
    }
}
