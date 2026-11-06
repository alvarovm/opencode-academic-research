import { Plugin } from "@opencode/plugin"
import { readFileSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * ars-session-loaded
 *
 * OpenCode plugin for the Academic Research Skills suite.
 * Compatible with OpenCode v2 (and v1 via dual-export).
 *
 * Hooks:
 *   event (session.created)         — logs a startup notice confirming ARS is active
 *   tool.execute.before             — write-scope guard: enforces per-agent write
 *                                     boundaries from ars_phase_scope_manifest.json
 *   shell.create.before / shell.env — injects ARS env vars into shell executions
 *   session.hook("compaction")      — preserves ARS state across context compaction
 *
 * The write guard is ADVISORY by default — it logs violations but does not
 * block writes. Set ARS_WRITE_GUARD=strict to throw and block out-of-scope writes.
 */

// --- Types ---

interface AgentEntry {
  bucket: string
  skill: string
  phase: string
  allowed_write_globs: string[]
}

interface PhaseManifest {
  version: number
  agents: Record<string, AgentEntry>
}

// --- Helpers ---

/**
 * Load the phase scope manifest from the repo.
 * Searches relative to plugin location and cwd.
 */
function loadManifest(pluginDir: string, workDir: string): PhaseManifest | null {
  const candidates = [
    resolve(pluginDir, "..", "scripts", "ars_phase_scope_manifest.json"),
    resolve(workDir, "scripts", "ars_phase_scope_manifest.json"),
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf-8"))
      } catch {
        return null
      }
    }
  }
  return null
}

// Match a file path against a glob pattern.
// Supports patterns like phase1_* or phase7_*.
function matchGlob(filePath: string, glob: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "")
  const regexStr = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/{{GLOBSTAR}}/g, ".*")
  return new RegExp(`^${regexStr}$`).test(normalized)
}

/**
 * Count unique *_agent.md files in a directory tree.
 */
function countAgents(workDir: string): number {
  try {
    const { execSync } = require("node:child_process")
    const output = execSync(
      `find "${workDir}/skills" -name "*_agent.md" -not -path "*/.git/*" 2>/dev/null | wc -l`,
      { encoding: "utf-8" },
    )
    return parseInt(output.trim(), 10) || 0
  } catch {
    return 38 // fallback to known count
  }
}

/**
 * Count *_agent.md files within a single skill directory.
 */
function countSkillAgents(workDir: string, skill: string): number {
  try {
    const { execSync } = require("node:child_process")
    const output = execSync(
      `find "${workDir}/skills/${skill}" -name "*_agent.md" -not -path "*/.git/*" 2>/dev/null | wc -l`,
      { encoding: "utf-8" },
    )
    return parseInt(output.trim(), 10) || 0
  } catch {
    return 0
  }
}

function buildStartupMessage(workDir: string, manifest: PhaseManifest | null, isStrict: boolean): string {
  const guardStatus = manifest
    ? `active${isStrict ? " [STRICT — will block out-of-scope writes]" : " [advisory]"}`
    : "manifest not found (guard disabled)"

  return [
    `Academic Research Skills (ARS) v3.13.0 loaded.`,
    ``,
    `Skills:`,
    `  deep-research            ${countSkillAgents(workDir, "deep-research")} agents, 8 modes`,
    `  academic-paper           ${countSkillAgents(workDir, "academic-paper")} agents, 11 modes`,
    `  academic-paper-reviewer   ${countSkillAgents(workDir, "academic-paper-reviewer")} agents, 6 modes`,
    `  academic-pipeline        10-stage orchestrator`,
    ``,
    `Commands: 16 (/ars-plan, /ars-full, /ars-lit-review, /ars-reviewer, ...)`,
    `Agents: ${countAgents(workDir)} unique *_agent.md files`,
    `Write-scope guard: ${guardStatus}`,
  ].join("\n")
}

const COMPACTION_PROMPT_STATE = `## ARS Pipeline State (preserved across compaction)

This session uses the Academic Research Skills (ARS) v3.13.0 suite.

Key context to preserve:
- Active skill and mode (check the most recent /ars-* command invocation)
- Current pipeline phase (if running /ars-full, note which stage: research/write/review/revise/finalize)
- Material Passport path and any human-read acknowledgments
- Citation keys that failed verification (need re-check or /ars-cache-invalidate)
- Write-scope guard mode
- Any cross-model verification results or integrity gate outcomes

Available commands: /ars-plan, /ars-full, /ars-lit-review, /ars-reviewer,
/ars-revision, /ars-revision-coach, /ars-abstract, /ars-outline,
/ars-citation-check, /ars-format-convert, /ars-disclosure,
/ars-mark-read, /ars-unmark-read, /ars-cache-invalidate, /ars-3w, /ars-rebuttal-audit

Routing: if the user's intent spans multiple pipeline phases, clarify before routing.
Do NOT auto-route ambiguous cross-phase materials to a single-phase agent.`

// --- OpenCode V2 Plugin Definition ---

const arsPluginV2 = Plugin.define({
  id: "ars-session-loaded",
  async setup(ctx) {
    const pluginDir = dirname(fileURLToPath(import.meta.url))
    const workDir = ctx.location.directory
    const manifest = loadManifest(pluginDir, workDir)
    const isStrict = process.env.ARS_WRITE_GUARD === "strict"
    const startupMessage = buildStartupMessage(workDir, manifest, isStrict)

    // 1. Session announcement: log notice when session is created
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "session.created") {
            console.log(`[ars-session-loaded] ${startupMessage}`)
          }
        }
      } catch {
        // Ignored on controller abort
      }
    })()

    // 2. Write-scope guard: enforce phase boundaries on file writes
    await ctx.tool.hook("execute.before", async (event) => {
      if (!manifest) return

      const writeTools = ["write", "edit", "multiedit", "apply_patch"]
      const toolName = (event.tool ?? "").toLowerCase()
      if (!writeTools.includes(toolName)) return

      const args = event.input as Record<string, unknown> | undefined
      const filePath =
        (args?.filePath as string) ??
        (args?.file_path as string) ??
        (args?.path as string) ??
        ""
      if (!filePath) return

      const relative = filePath.startsWith(workDir)
        ? filePath.slice(workDir.length + 1)
        : filePath.replace(/^\.\//, "")

      if (!/^phase\d/.test(relative)) return

      const inScope = Object.values(manifest.agents).some((entry) =>
        entry.allowed_write_globs.some((glob) => matchGlob(relative, glob)),
      )

      if (!inScope) {
        const msg =
          `[ARS write-guard] write to "${relative}" is outside all ` +
          `agents' allowed_write_globs in ars_phase_scope_manifest.json`

        if (isStrict) {
          console.error(`[ars-write-guard] BLOCKED: ${msg}`)
          throw new Error(msg)
        }

        console.warn(`[ars-write-guard] WARNING: ${msg}`)
      }
    })

    // 3. Shell env: inject ARS environment variables
    await ctx.shell.hook("create.before", (event) => {
      if (!event.env.ARS_MANIFEST_PATH && manifest) {
        const manifestPath = resolve(workDir, "scripts", "ars_phase_scope_manifest.json")
        if (existsSync(manifestPath)) {
          event.env.ARS_MANIFEST_PATH = manifestPath
        }
      }
      if (isStrict && !event.env.ARS_WRITE_GUARD) {
        event.env.ARS_WRITE_GUARD = "strict"
      }
    })

    // 4. Compaction context preservation
    await ctx.session.hook("compaction", (event) => {
      event.system.push({
        type: "text",
        text: COMPACTION_PROMPT_STATE,
      })
    })

    return () => {
      controller.abort()
    }
  },
})

// --- Legacy OpenCode V1 Handler (for backwards compatibility) ---

export const ARSPlugin = async ({ client, directory, worktree }: any) => {
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  const workDir = worktree || directory || process.cwd()
  const manifest = loadManifest(pluginDir, workDir)
  const isStrict = process.env.ARS_WRITE_GUARD === "strict"
  const startupMessage = buildStartupMessage(workDir, manifest, isStrict)

  return {
    event: async ({ event }: any) => {
      if (event.type === "session.created") {
        try {
          await client?.app?.log({
            body: {
              service: "ars-session-loaded",
              level: "info",
              message: startupMessage,
            },
          })
        } catch {
          // Best effort
        }
      }
    },
    "tool.execute.before": async (input: any, output: any) => {
      if (!manifest) return
      const writeTools = ["write", "edit", "multiedit", "apply_patch"]
      const toolName = (input.tool ?? "").toLowerCase()
      if (!writeTools.includes(toolName)) return
      const args = output?.args as Record<string, unknown> | undefined
      const filePath =
        (args?.filePath as string) ??
        (args?.file_path as string) ??
        (args?.path as string) ??
        ""
      if (!filePath) return
      const relative = filePath.startsWith(workDir)
        ? filePath.slice(workDir.length + 1)
        : filePath.replace(/^\.\//, "")
      if (!/^phase\d/.test(relative)) return
      const inScope = Object.values(manifest.agents).some((entry) =>
        entry.allowed_write_globs.some((glob) => matchGlob(relative, glob)),
      )
      if (!inScope) {
        const msg =
          `[ARS write-guard] write to "${relative}" is outside all ` +
          `agents' allowed_write_globs in ars_phase_scope_manifest.json`
        if (isStrict) {
          throw new Error(msg)
        }
      }
    },
    "shell.env": async (_input: any, output: any) => {
      const env = output.env as Record<string, string>
      if (!env.ARS_MANIFEST_PATH && manifest) {
        const manifestPath = resolve(workDir, "scripts", "ars_phase_scope_manifest.json")
        if (existsSync(manifestPath)) {
          env.ARS_MANIFEST_PATH = manifestPath
        }
      }
      if (isStrict && !env.ARS_WRITE_GUARD) {
        env.ARS_WRITE_GUARD = "strict"
      }
    },
    "experimental.session.compacting": async (_input: any, output: any) => {
      const context = output.context as string[]
      context.push(COMPACTION_PROMPT_STATE)
    },
  }
}

export default {
  ...arsPluginV2,
  async server(v1Context: any) {
    return ARSPlugin(v1Context)
  },
}
