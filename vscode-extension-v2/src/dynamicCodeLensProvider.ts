import * as vscode from 'vscode';


export class DynamicCodeLensProvider implements vscode.CodeLensProvider {
    private codeLensRange: vscode.Range | undefined;
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    constructor() {
        // Listen to text selection changes
        vscode.window.onDidChangeTextEditorSelection((event) => {
            const isEnabled = vscode.workspace.getConfiguration('pytypewizard').get('enableCodeLens');
            if (!isEnabled) {
                this.codeLensRange = undefined;
                this._onDidChangeCodeLenses.fire();
                return;
            }

            const selection = event.selections[0];
            if (!selection.isEmpty) {
                this.codeLensRange = new vscode.Range(selection.start, selection.end);
            } else {
                this.codeLensRange = undefined;
            }

            this._onDidChangeCodeLenses.fire();
        });

        // Listen to configuration changes
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('pytypewizard.enableCodeLens')) {
                this._onDidChangeCodeLenses.fire();
            }
        });
    }

    provideCodeLenses(_document: vscode.TextDocument, _token: vscode.CancellationToken) {
        const isEnabled = vscode.workspace.getConfiguration('pytypewizard').get('enableCodeLens');
        if (!isEnabled) {
            return [];
        }

        if (this.codeLensRange) {
            const codeLens = new vscode.CodeLens(this.codeLensRange);
            codeLens.command = {
                title: "Ask PyTypeWizard",
                command: "pytypewizard.addToChat",
                tooltip: "Click to add this value to the chat",
                arguments: [() => {
                    this.codeLensRange = undefined;
                    this._onDidChangeCodeLenses.fire();
                }]
            };
            return [codeLens];
        }
        return [];
    }
}


// Register the "Add to Chat" command
export const addToChatCommand = vscode.commands.registerCommand('pytypewizard.addToChat', (callback?: () => void) => {
    vscode.window.showInformationMessage('Value added to chat!');
    if (callback) {
        callback();
    }
});
