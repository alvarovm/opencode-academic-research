#!/usr/bin/env bash
#
# install.sh — symlink ARS skills, commands, agents, and plugins into
# OpenCode configuration so OpenCode auto-discovers them.
#
# OpenCode discovers from two locations:
#   1. Global: $XDG_CONFIG_HOME/opencode/{skills,commands,agents,plugins}/
#      (works from ANY directory — default install location)
#   2. Project-local: <project>/.opencode/{skills,commands,agents,plugins}/
#      (scoped to a specific project — use --local)
#
# Usage:
#   ./install.sh                            # symlink into ~/.config/opencode/ (global)
#   ./install.sh --local [DIR]              # symlink into [DIR]/.opencode/ (project-local, default: ./)
#   ./install.sh --force                    # overwrite existing symlinks/files
#   ./install.sh --dry-run                  # print what would happen, do nothing
#   ./install.sh --uninstall                # remove global symlinks
#   ./install.sh --uninstall --local [DIR]  # remove local project symlinks
#
# Idempotent. Safe to run repeatedly.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FORCE=0
DRY_RUN=0
UNINSTALL=0
LOCAL=0
TARGET_PATH=""

show_help() {
    sed -n '2,19p' "$0" | sed 's/^# \?//'
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --force)
            FORCE=1
            ;;
        --dry-run)
            DRY_RUN=1
            ;;
        --uninstall)
            UNINSTALL=1
            ;;
        -l|--local|--project)
            LOCAL=1
            if [[ $# -gt 1 && ! "$2" =~ ^- ]]; then
                TARGET_PATH="$2"
                shift
            fi
            ;;
        --local=*|--project=*)
            LOCAL=1
            TARGET_PATH="${1#*=}"
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 1
            ;;
    esac
    shift
done

resolve_local_target() {
    local target="${1:-.}"
    if [[ "$(basename "$target")" == ".opencode" ]]; then
        echo "$target"
    else
        echo "$target/.opencode"
    fi
}

if [[ $LOCAL -eq 1 ]]; then
    target_path="$(resolve_local_target "$TARGET_PATH")"
    if [[ "$target_path" = /* ]]; then
        INSTALL_TARGET="$target_path"
    else
        INSTALL_TARGET="$(pwd)/$target_path"
    fi
    if [[ $DRY_RUN -eq 0 ]]; then
        mkdir -p "$INSTALL_TARGET"
        INSTALL_TARGET="$(cd "$INSTALL_TARGET" && pwd)"
    fi
else
    CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
    INSTALL_TARGET="$CONFIG_HOME/opencode"
fi

run() {
    if [[ $DRY_RUN -eq 1 ]]; then
        echo "  [dry-run] $*"
    else
        "$@"
    fi
}

link_one() {
    local src="$1"
    local dest="$2"
    local name
    name="$(basename "$src")"

    if [[ -L "$dest" ]]; then
        local current
        current="$(readlink "$dest")"
        if [[ "$current" == "$src" ]]; then
            echo "  ok    $name (already linked)"
            return
        fi
        if [[ $FORCE -eq 1 ]]; then
            echo "  retag $name (was: $current)"
            run rm "$dest"
        else
            echo "  skip  $name (different symlink: $current; use --force)" >&2
            return
        fi
    elif [[ -e "$dest" ]]; then
        if [[ $FORCE -eq 1 ]]; then
            echo "  back  $name -> $name.bak"
            run mv "$dest" "$dest.bak"
        else
            echo "  skip  $name (file/dir exists; use --force to back up)" >&2
            return
        fi
    fi

    echo "  link  $name"
    run ln -s "$src" "$dest"
}

unlink_one() {
    local dest="$1"
    local name
    name="$(basename "$dest")"
    if [[ -L "$dest" ]]; then
        local current
        current="$(readlink "$dest")"
        if [[ "$current" == "$REPO_ROOT/"* ]]; then
            echo "  unlink $name"
            run rm "$dest"
            return
        fi
        echo "  skip  $name (symlink does not point into this repo: $current)" >&2
        return
    fi
    if [[ -e "$dest" ]]; then
        echo "  skip  $name (not a symlink)" >&2
        return
    fi
    echo "  ok    $name (already absent)"
}

ensure_dir() {
    local d="$1"
    if [[ ! -d "$d" ]]; then
        echo "  mkdir $d"
        run mkdir -p "$d"
    fi
}

main_install() {
    echo "Installing into: $INSTALL_TARGET"
    ensure_dir "$INSTALL_TARGET/skills"
    ensure_dir "$INSTALL_TARGET/commands"
    ensure_dir "$INSTALL_TARGET/agents"
    ensure_dir "$INSTALL_TARGET/plugins"

    echo "Skills:"
    for d in "$REPO_ROOT/skills"/*/; do
        [[ -d "$d" ]] || continue
        local name
        name="$(basename "$d")"
        link_one "${d%/}" "$INSTALL_TARGET/skills/$name"
    done

    echo "Commands:"
    for f in "$REPO_ROOT/commands"/*.md; do
        [[ -f "$f" ]] || continue
        link_one "$f" "$INSTALL_TARGET/commands/$(basename "$f")"
    done

    echo "Agents:"
    for f in "$REPO_ROOT/.opencode/agents"/*.md; do
        [[ -f "$f" ]] || continue
        link_one "$f" "$INSTALL_TARGET/agents/$(basename "$f")"
    done

    echo "Plugins:"
    for f in "$REPO_ROOT/plugins"/*.ts; do
        [[ -f "$f" ]] || continue
        link_one "$f" "$INSTALL_TARGET/plugins/$(basename "$f")"
    done

    echo
    echo "Next steps:"
    if [[ $LOCAL -eq 1 ]]; then
        echo "  1. bun install in $REPO_ROOT (if not already run)"
        echo "  2. uv sync --extra dev in $REPO_ROOT (if not already run)"
        echo "  3. open OpenCode in your project folder and try: /ars-plan"
    else
        echo "  1. bun install                # in this repo, so the plugin runs"
        echo "  2. uv sync --extra dev        # in this repo, so the Python scripts run"
        echo "  3. open OpenCode and try: /ars-plan"
        echo
        echo "Note: When working INSIDE this repo, OpenCode auto-discovers from"
        echo ".opencode/ without needing this install. The global install makes"
        echo "ARS available from any working directory."
    fi
}

main_uninstall() {
    echo "Uninstalling from: $INSTALL_TARGET"

    echo "Skills:"
    for d in "$REPO_ROOT/skills"/*/; do
        [[ -d "$d" ]] || continue
        local name
        name="$(basename "$d")"
        unlink_one "$INSTALL_TARGET/skills/$name"
    done

    echo "Commands:"
    for f in "$REPO_ROOT/commands"/*.md; do
        [[ -f "$f" ]] || continue
        unlink_one "$INSTALL_TARGET/commands/$(basename "$f")"
    done

    echo "Agents:"
    for f in "$REPO_ROOT/.opencode/agents"/*.md; do
        [[ -f "$f" ]] || continue
        unlink_one "$INSTALL_TARGET/agents/$(basename "$f")"
    done

    echo "Plugins:"
    for f in "$REPO_ROOT/plugins"/*.ts; do
        [[ -f "$f" ]] || continue
        unlink_one "$INSTALL_TARGET/plugins/$(basename "$f")"
    done
}

if [[ $UNINSTALL -eq 1 ]]; then
    main_uninstall
else
    main_install
fi
