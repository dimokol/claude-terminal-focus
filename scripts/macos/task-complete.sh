#!/bin/bash
PROJECT_PATH="$PWD"
PROJECT_NAME=$(basename "$PROJECT_PATH")

# Find the VS Code workspace root: walk up from $PWD, collect the topmost .vscode
# directory found, but stop at $HOME (don't use ~/.vscode which is global VS Code config)
WORKSPACE_ROOT="$PROJECT_PATH"
SEARCH_DIR="$PROJECT_PATH"
while [ "$SEARCH_DIR" != "/" ] && [ "$SEARCH_DIR" != "$HOME" ]; do
    if [ -d "$SEARCH_DIR/.vscode" ]; then
        WORKSPACE_ROOT="$SEARCH_DIR"
    fi
    SEARCH_DIR=$(dirname "$SEARCH_DIR")
done

# Write ancestor PID chain for terminal tab matching (VS Code extension reads this)
mkdir -p "$WORKSPACE_ROOT/.vscode"
SIGNAL_FILE="$WORKSPACE_ROOT/.vscode/.claude-focus"
PID_CHAIN=""
CURRENT_PID=$$
while [ "$CURRENT_PID" -gt 1 ] 2>/dev/null; do
    PID_CHAIN="${PID_CHAIN}${CURRENT_PID}\n"
    CURRENT_PID=$(ps -o ppid= -p "$CURRENT_PID" 2>/dev/null | tr -d ' ')
    [ -z "$CURRENT_PID" ] && break
done
printf "%b" "$PID_CHAIN" > "$SIGNAL_FILE"

# Play the task-complete sound (foreground — < 1 second, must not be killed early)
afplay /System/Library/Sounds/Glass.aiff

# Show banner notification — clicking it creates a marker file AND opens the correct VS Code window
CLICKED_FILE="$WORKSPACE_ROOT/.vscode/.claude-focus-clicked"
nohup terminal-notifier \
    -title "Claude Code - Done" \
    -message "Task completed in: $PROJECT_NAME" \
    -execute "touch '${CLICKED_FILE}' && /usr/local/bin/code '${WORKSPACE_ROOT}'" \
    -group "claude-$PROJECT_NAME" \
    >/dev/null 2>&1 &
disown
