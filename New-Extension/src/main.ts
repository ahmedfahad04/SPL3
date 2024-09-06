/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file Entry point for Pyre's VSCode extension.
 */

import { EnvironmentPath, PVSC_EXTENSION_ID, PythonExtension } from '@vscode/python-extension';
import axios from 'axios';
import { spawn } from 'child_process';
import { existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { exec } from 'child_process';


import { DidChangeConfigurationNotification, LanguageClient, LanguageClientOptions } from 'vscode-languageclient';
import which from 'which';

import { PyreCodeActionProvider } from './codeActionProvider';

type LanguageClientState = {
	languageClient: LanguageClient,
	configListener: Promise<vscode.Disposable>
}

// Extension state
let state: LanguageClientState | undefined;
let envListener: vscode.Disposable | undefined;
let outputChannel = vscode.window.createOutputChannel("pyre");

export async function activate(context: vscode.ExtensionContext) {

	let pythonExtension = vscode.extensions.getExtension<PythonExtension>(PVSC_EXTENSION_ID);

	if (!pythonExtension) {
		// Python extension is not installed
		const installPython = await vscode.window.showInformationMessage(
			'The Python extension is required for Pyre. Would you like to install it?',
			'Yes', 'No'
		);

		if (installPython === 'Yes') {
			await vscode.commands.executeCommand('workbench.extensions.installExtension', PVSC_EXTENSION_ID);
			pythonExtension = vscode.extensions.getExtension<PythonExtension>(PVSC_EXTENSION_ID);
		} else {
			vscode.window.showWarningMessage('Pyre extension cannot function without the Python extension.');
			return;
		}
	}

	if (!pythonExtension) {
		vscode.window.showErrorMessage('Failed to load Python extension. Pyre cannot function.');
		return;
	}

	if (!pythonExtension.isActive) {
		await pythonExtension.activate();
	}

	const activatedEnvPath = pythonExtension.exports.environments.getActiveEnvironmentPath();  // `/bin/python`
	const pyrePath = await findPyreCommand(activatedEnvPath);

	//! install pyre
	if (!pyrePath) {
		const installPyre = await vscode.window.showInformationMessage(
			'Pyre is not installed. Would you like to install it?',
			'Yes', 'No'
		);

		if (installPyre === 'Yes') {
			const installProgress = vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: "Installing Pyre",
				cancellable: false
			}, async (progress) => {
				progress.report({ increment: 0 });

				return new Promise<void>((resolve, reject) => {
					exec('pip install pyre-check', (error, stdout, stderr) => {
						if (error) {
							vscode.window.showErrorMessage('Failed to install Pyre. Please install it manually.');
							reject(error);
						} else {
							vscode.window.showInformationMessage('Pyre installed successfully!');
							resolve();
						}
					});
				});
			});

			await installProgress;
			const newPyrePath = await findPyreCommand(activatedEnvPath);
			if (newPyrePath) {
				state = createLanguageClient(newPyrePath);
			}
		}
	} else {

		//! install pyre configuration
		const pyreConfigExists = vscode.workspace.workspaceFolders?.some(folder => {
			vscode.window.showInformationMessage(`PYRE CONFIG: ${path.join(folder.uri.fsPath, '.pyre_configuration')}`)
			existsSync(path.join(folder.uri.fsPath, '.pyre_configuration'))
		}
		);

		if (!pyreConfigExists) {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;

			if (workspaceFolder) {
				// Create .watchmanconfig file
				const watchmanConfigPath = path.join(workspaceFolder, '.watchmanconfig');
				fs.writeFileSync(watchmanConfigPath, '{}');

				// Create .pyre_configuration file
				const pyreConfigPath = path.join(workspaceFolder, '.pyre_configuration');
				const pyreConfigContent = JSON.stringify({
					"site_package_search_strategy": "pep561",
					"source_directories": [
						"."
					]
				}, null, 2);
				fs.writeFileSync(pyreConfigPath, pyreConfigContent);

				vscode.window.showInformationMessage('Pyre configuration added successfully.');
			} else {
				vscode.window.showErrorMessage('Unable to determine workspace folder.');
			}
		}

		state = createLanguageClient(pyrePath);
	}

	// Quick Fix Provider
	const codeActionProvider = new PyreCodeActionProvider();
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			{ scheme: 'file', language: 'python' },
			codeActionProvider,
			{
				providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
			}
		)
	);

	// Command execution
	vscode.commands.registerCommand('pyre.fixError', (document: vscode.TextDocument, diagnostic: vscode.Diagnostic) => {
		const filePath = document.uri.fsPath;
		const errMessage = diagnostic.message;
		const lineNum = diagnostic.range.start.line + 1;
		const colNum = diagnostic.range.start.character + 1;
		const outputDir = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
		const errType = errMessage.split(':', 2)

		runErrorExtractor(context, filePath, errType[0], errMessage, lineNum, colNum, outputDir, activatedEnvPath.path);
	});


	envListener = pythonExtension.exports.environments.onDidChangeActiveEnvironmentPath(async (e) => {
		state?.languageClient?.stop();
		state?.configListener.then((listener) => listener.dispose());
		state = undefined;

		const pyrePath = await findPyreCommand(e);
		if (pyrePath) {
			state = createLanguageClient(pyrePath);
		}
	});
}

function createLanguageClient(pyrePath: string): LanguageClientState {

	const serverOptions = {
		command: pyrePath,
		args: ["persistent"]
	};

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'python' }],
		synchronize: {
			// Notify the server about file changes to '.clientrc files contain in the workspace
			fileEvents: vscode.workspace.createFileSystemWatcher('**/.clientrc'),
		}
	};

	const languageClient = new LanguageClient(
		'pyre',
		'Pyre Language Client',
		serverOptions,
		clientOptions,
	)

	languageClient.registerProposedFeatures();

	const configListener = languageClient.onReady().then(() => {
		return vscode.workspace.onDidChangeConfiguration(() => {
			languageClient.sendNotification(DidChangeConfigurationNotification.type, { settings: null });
		});
	});

	languageClient.start();

	return { languageClient, configListener };
}

function runErrorExtractor(context: vscode.ExtensionContext, filePath: string, errType: string, errMessage: string, lineNum: number, colNum: number, outputDir: string, pythonPath: string) {
	const scriptPath = path.join(context.extensionPath, 'src', 'error_extractor.py');

	const process = spawn(pythonPath, [
		scriptPath,
		filePath,
		errType,
		errMessage,
		lineNum.toString(),
		colNum.toString(),
		outputDir
	]);

	let output = '';

	process.stdout.on('data', (data) => {
		output += data.toString();
		console.log(`Error extractor output: ${data}`);
	});

	process.stderr.on('data', (data) => {
		console.error(`Error extractor error: ${data}`);
	});

	process.on('close', async (code) => {
		console.log(`Error extractor process exited with code ${code}`);
		if (code === 0 && output) {
			try {
				console.log("RAW: \n", output)
				const jsonOutput = JSON.parse(output);
				console.log("PAYLOAD: ", jsonOutput)
				await sendApiRequest(jsonOutput);
			} catch (error) {
				console.error('Error parsing output or sending API request:', error);
			}
		}
	});
}

async function sendApiRequest(payload: any) {
	const apiUrl = 'http://127.0.0.1:8000/get-fixes';

	// Show loading message
	const loadingMessage = vscode.window.setStatusBarMessage('Sending data to API...');

	try {
		const response = await axios.post(apiUrl, payload);
		console.log('API response:', response.data);
		vscode.window.showInformationMessage('Data sent to API successfully!');
	} catch (error) {
		console.error('API request failed:', error);
		vscode.window.showErrorMessage('Failed to send data to API. Check console for details.');
	} finally {
		// Clear the loading message
		loadingMessage.dispose();
	}
}

async function findPyreCommand(envPath: EnvironmentPath): Promise<string | undefined> {

	if (envPath.id === 'DEFAULT_PYTHON') {
		outputChannel.appendLine(`Using the default python environment`);
		vscode.window.showInformationMessage(`Using the default python environment`);
		return 'pyre';
	}

	const path = envPath.path;
	const stat = statSync(path)

	const pyrePath = stat.isFile()
		? join(dirname(envPath.path), 'pyre')
		: stat.isDirectory()
			? join(path, 'bin', 'pyre')
			: undefined;

	if (pyrePath && existsSync(pyrePath) && statSync(pyrePath).isFile()) {
		outputChannel.appendLine(`Using pyre path: ${pyrePath} from python environment: ${envPath.id} at ${envPath.path}`);
		return pyrePath;
	}

	const pyreFromPathEnvVariable = await which('pyre', { nothrow: true });
	if (pyreFromPathEnvVariable != null) {
		outputChannel.appendLine(`Using pyre path: ${pyreFromPathEnvVariable} from PATH`);
		return pyreFromPathEnvVariable;
	}

	outputChannel.appendLine(`Could not find pyre path from python environment: ${envPath.id} at ${envPath.path}`);
	return undefined;
}

export function deactivate() {
	state?.languageClient.stop();
	state?.configListener.then((listener) => listener.dispose());
	envListener?.dispose();
}
