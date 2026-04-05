const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const SIGNAL_NAME = '.claude-focus';
const CLICKED_NAME = '.claude-focus-clicked';
const POLL_MS = 800;

function activate(context) {
    const log = vscode.window.createOutputChannel('Claude Terminal Focus');
    log.appendLine('Claude Terminal Focus extension activated');
    log.appendLine(`Workspace folders: ${(vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath).join(', ') || 'none'}`);

    // Poll for the clicked marker file (macOS: created by terminal-notifier on notification click)
    // VS Code file watchers don't detect dotfiles reliably, so polling is used instead
    const timer = setInterval(() => {
        if (!vscode.workspace.workspaceFolders) return;

        for (const folder of vscode.workspace.workspaceFolders) {
            const clickedPath = path.join(folder.uri.fsPath, '.vscode', CLICKED_NAME);

            if (fs.existsSync(clickedPath)) {
                log.appendLine(`Notification clicked — switching terminal (${folder.name})`);
                try { fs.unlinkSync(clickedPath); } catch (_) {}

                const signalPath = path.join(folder.uri.fsPath, '.vscode', SIGNAL_NAME);
                handleClick(signalPath, log);
                return;
            }
        }
    }, POLL_MS);

    context.subscriptions.push({ dispose: () => clearInterval(timer) });

    // Also check on window focus (Windows: toast notification opens vscode:// URI which triggers focus change)
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState((state) => {
            if (state.focused) {
                checkSignalFiles(log);
            }
        })
    );

    log.appendLine(`Polling every ${POLL_MS}ms for notification clicks`);
    log.appendLine('Also listening for window focus events (Windows toast support)');
    log.appendLine('Ready — will focus terminal only when notification is clicked');
}

function checkSignalFiles(log) {
    if (!vscode.workspace.workspaceFolders) return;

    for (const folder of vscode.workspace.workspaceFolders) {
        const signalPath = path.join(folder.uri.fsPath, '.vscode', SIGNAL_NAME);
        if (fs.existsSync(signalPath)) {
            log.appendLine(`Signal found on window focus: ${folder.name}`);
            handleClick(signalPath, log);
            return;
        }
    }
}

async function handleClick(signalPath, log) {
    let content;
    try {
        content = fs.readFileSync(signalPath, 'utf8').trim();
    } catch (err) {
        log.appendLine(`No signal file found: ${err.message}`);
        await vscode.commands.executeCommand('workbench.action.terminal.focus');
        return;
    }

    try { fs.unlinkSync(signalPath); } catch (_) {}

    const ancestorPids = content
        .split(/\r?\n/)
        .map(s => parseInt(s.trim(), 10))
        .filter(n => !isNaN(n) && n > 0);

    log.appendLine(`Signal PIDs: ${ancestorPids.join(', ')}`);

    const terminals = vscode.window.terminals;
    log.appendLine(`Open terminals (${terminals.length}): ${terminals.map(t => t.name).join(', ')}`);

    // Try matching by PID — check if any terminal's shell PID is in the ancestor chain
    for (const terminal of terminals) {
        try {
            const termPid = await terminal.processId;
            if (termPid && ancestorPids.includes(termPid)) {
                log.appendLine(`PID match: "${terminal.name}" (PID ${termPid})`);
                await focusTerminal(terminal, log);
                return;
            }
        } catch (_) {}
    }

    // Try matching by terminal name — Claude terminals often contain "claude" or "node"
    for (const terminal of terminals) {
        const name = terminal.name.toLowerCase();
        if (name.includes('claude') || name.includes('node')) {
            log.appendLine(`Name match: "${terminal.name}"`);
            await focusTerminal(terminal, log);
            return;
        }
    }

    // Fallback: show the last terminal (most recently created)
    if (terminals.length > 0) {
        const lastTerminal = terminals[terminals.length - 1];
        log.appendLine(`Fallback: showing last terminal "${lastTerminal.name}"`);
        await focusTerminal(lastTerminal, log);
        return;
    }

    log.appendLine('No terminals found to focus');
}

async function focusTerminal(terminal, log) {
    // Step 1: Make the terminal panel visible and focused
    await vscode.commands.executeCommand('workbench.action.terminal.focus');

    // Step 2: Show the specific terminal tab (this makes it the active terminal)
    terminal.show();

    // Step 3: Verify it switched
    setTimeout(() => {
        const active = vscode.window.activeTerminal;
        log.appendLine(`Active terminal after switch: "${active?.name || 'none'}"`);
    }, 300);
}

function deactivate() {}

module.exports = { activate, deactivate };
