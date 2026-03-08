/**
 * π-PAI v3.1 — Personal AI Infrastructure Extension for Pi
 *
 * Merges:
 * 1. Daniel Miessler's PAI Algorithm (7-phase, ISC, effort levels, learnings)
 * 2. disler's damage-control (97+ bash patterns via YAML)
 * 3. disler's pi-vs-claude-code extension patterns (widgets, tool_call hooks)
 *
 * v3.1: Carmack review — killed hand-rolled YAML parser (→ js-yaml),
 * split /pai switch into dispatch table, externalized templates to JSON,
 * fixed isPathMatch to single canonical strategy.
 *
 * v3.1.1: Fix Ralph event handler — typed event access, guard null mission in widget.
 */

import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent'
import { Type } from '@sinclair/typebox'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import YAML from 'js-yaml'

// ── Types ────────────────────────────────────────────────────────────────────

type AlgorithmPhase = 'OBSERVE' | 'THINK' | 'PLAN' | 'DEFINE' | 'EXECUTE' | 'MEASURE' | 'LEARN'
type EffortLevel = 'instant' | 'fast' | 'standard' | 'extended' | 'deep'
type GoalStatus = 'active' | 'blocked' | 'completed' | 'paused'

interface Goal { id: string; title: string; status: GoalStatus; priority: string; isc?: string[] }
interface Challenge { id: string; title: string; severity: string; affectedGoals: string[] }
interface Learning { insight: string; confidence: number; category: string; timestamp: Date; fromRating?: number }
interface Rating { score: number; context: string; timestamp: Date }

interface InnerLoopState {
  phase: AlgorithmPhase
  goal: string
  effort: EffortLevel
  isc: string[]
  data: Record<string, string>
  startTime: number
}

interface PAIState {
  mission: string | null
  goals: Map<string, Goal>
  challenges: Map<string, Challenge>
  learnings: Learning[]
  ratings: Rating[]
  innerLoop: InnerLoopState | null
  iterationCount: number
  ralphIteration: number
  ralphActive: boolean
}

// ── Damage Control Types ─────────────────────────────────────────────────────

interface DamageRule { pattern: string; reason: string; ask?: boolean }
interface DamageRules {
  bashToolPatterns: DamageRule[]
  zeroAccessPaths: string[]
  readOnlyPaths: string[]
  noDeletePaths: string[]
}

const EMPTY_RULES: DamageRules = { bashToolPatterns: [], zeroAccessPaths: [], readOnlyPaths: [], noDeletePaths: [] }

function loadDamageRules(cwd: string): DamageRules {
  const candidates = [
    path.join(cwd, '.pi', 'damage-control-rules.yaml'),
    path.join(cwd, 'damage-control-rules.yaml'),
    path.join(__dirname, '..', 'damage-control-rules.yaml'),
  ]
  for (const f of candidates) {
    try {
      if (!fs.existsSync(f)) continue
      const raw = YAML.load(fs.readFileSync(f, 'utf8')) as Partial<DamageRules>
      return {
        bashToolPatterns: raw.bashToolPatterns || [],
        zeroAccessPaths: raw.zeroAccessPaths || [],
        readOnlyPaths: raw.readOnlyPaths || [],
        noDeletePaths: raw.noDeletePaths || [],
      }
    } catch { /* skip bad files */ }
  }
  return EMPTY_RULES
}

// Single canonical path match: normalize both sides, use startsWith for dirs, exact basename for globs
function isPathMatch(target: string, pattern: string, cwd: string): boolean {
  const expanded = pattern.startsWith('~') ? path.join(os.homedir(), pattern.slice(1)) : pattern
  const norm = path.normalize(expanded).replace(/\\/g, '/')
  const abs = path.normalize(path.isAbsolute(target) ? target : path.resolve(cwd, target)).replace(/\\/g, '/')

  // Directory pattern: target must be inside it
  if (norm.endsWith('/')) return abs.startsWith(norm) || abs.startsWith(norm.slice(0, -1))

  // Glob pattern: convert * to regex, match against basename and full path
  if (norm.includes('*')) {
    const re = new RegExp('^' + norm.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
    return re.test(path.basename(abs)) || re.test(abs)
  }

  // Exact: match basename or full path
  return path.basename(abs) === norm || abs.endsWith('/' + norm)
}

// ── Templates (external JSON, fallback to built-in) ──────────────────────────

interface Template { mission: string; goals: string[]; challenges: string[] }

function loadTemplates(): Record<string, Template> {
  // Try external file first
  const ext = path.join(__dirname, '..', 'templates.json')
  try {
    if (fs.existsSync(ext)) return JSON.parse(fs.readFileSync(ext, 'utf8'))
  } catch { /* fall through */ }

  return {
    trading: {
      mission: 'Build a profitable algorithmic trading system',
      goals: ['Develop and backtest core strategy', 'Achieve >55% win rate on paper trades', 'Deploy live with risk management', 'Maintain Sharpe ratio >1.5'],
      challenges: ['Overfitting risk on historical data', 'Execution latency in live markets'],
    },
    saas: {
      mission: 'Launch a production SaaS product',
      goals: ['Ship MVP with auth, billing, and core feature', 'Acquire first 10 paying users', 'Achieve <2s p95 page load', 'Set up CI/CD and monitoring'],
      challenges: ['Scope creep', 'Premature optimization'],
    },
    devops: {
      mission: 'Build reliable infrastructure and deployment pipeline',
      goals: ['Automate deployments with zero downtime', 'Set up monitoring and alerting', 'Achieve 99.9% uptime SLA', 'Document runbooks for on-call'],
      challenges: ['Alert fatigue', 'Configuration drift'],
    },
    research: {
      mission: 'Complete deep research project with actionable findings',
      goals: ['Define research questions and scope', 'Collect and analyze primary sources', 'Synthesize findings into report', 'Present recommendations'],
      challenges: ['Source reliability', 'Scope management'],
    },
    agent: {
      mission: 'Build and ship a production AI agent',
      goals: ['Define agent capabilities and constraints', 'Implement tool use and error handling', 'Test with adversarial inputs', 'Deploy with monitoring and kill switch'],
      challenges: ['Prompt injection risk', 'Cost control', 'Hallucination detection'],
    },
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function persist(pi: ExtensionAPI, key: string, data: Record<string, unknown>) {
  pi.appendEntry(key, { ...data, ts: new Date().toISOString() })
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const state: PAIState = {
    mission: null, goals: new Map(), challenges: new Map(),
    learnings: [], ratings: [], innerLoop: null,
    iterationCount: 0, ralphIteration: 0, ralphActive: false,
  }
  let rules: DamageRules = EMPTY_RULES
  let widgetCtx: ExtensionContext | null = null
  const PHASES: AlgorithmPhase[] = ['OBSERVE', 'THINK', 'PLAN', 'DEFINE', 'EXECUTE', 'MEASURE', 'LEARN']
  const EFFORTS: EffortLevel[] = ['instant', 'fast', 'standard', 'extended', 'deep']

  function notify(msg: string, type: 'error' | 'warning' | 'info' = 'info') {
    widgetCtx?.ui.notify(msg, type)
  }

  // ── Widget ─────────────────────────────────────────────────────────────

  function updateWidget() {
    if (!widgetCtx?.hasUI) return
    widgetCtx.ui.setWidget('pai-status', (_tui: any, theme: any) => ({
      render(width: number): string[] {
        const lines: string[] = []
        if (!state.mission) {
          lines.push(theme.fg('dim', '  π-PAI: /pai mission <statement> to begin'))
          return lines
        }

        const raw = state.mission ?? ''
        const m = raw.length > width - 20 ? raw.slice(0, width - 23) + '...' : raw
        lines.push(theme.fg('accent', '  🎯 ') + theme.fg('success', m))

        const goals = Array.from(state.goals.values())
        const a = goals.filter(g => g.status === 'active').length
        const b = goals.filter(g => g.status === 'blocked').length
        const c = goals.filter(g => g.status === 'completed').length
        const avg = state.ratings.length ? (state.ratings.reduce((s, r) => s + r.score, 0) / state.ratings.length).toFixed(1) : '—'

        if (goals.length || state.ratings.length) {
          lines.push(
            theme.fg('dim', '  Goals: ') + theme.fg('success', `${a}⚡`) + ' ' +
            theme.fg('warning', `${b}🚫`) + ' ' + theme.fg('muted', `${c}✓`) +
            theme.fg('dim', ' │ ') + theme.fg('accent', `${state.learnings.length} learnings`) +
            theme.fg('dim', ' │ ⭐') + theme.fg('accent', `${avg}`) + theme.fg('dim', ` (${state.ratings.length})`)
          )
        }

        if (state.innerLoop) {
          const idx = PHASES.indexOf(state.innerLoop.phase)
          const bar = PHASES.map((_, i) => i < idx ? theme.fg('success', '●') : i === idx ? theme.fg('accent', '◉') : theme.fg('dim', '○')).join(' ')
          const elapsed = Math.round((Date.now() - state.innerLoop.startTime) / 1000)
          lines.push(theme.fg('dim', '  Loop: ') + bar + theme.fg('dim', ` [${state.innerLoop.phase}] ${state.innerLoop.effort} ${elapsed}s`))
        }

        if (state.ralphActive) lines.push(theme.fg('warning', `  🔄 Ralph #${state.ralphIteration}`) + theme.fg('dim', ' running...'))
        return lines
      },
      invalidate() {},
    }))
  }

  // ── /pai subcommand dispatch table ─────────────────────────────────────

  const paiCommands: Record<string, (rest: string, ctx: ExtensionContext) => void> = {
    mission(rest, ctx) {
      if (!rest) { notify('Usage: /pai mission <statement>', 'error'); return }
      state.mission = rest
      persist(pi, 'pai-mission', { mission: rest })
      notify(`🎯 Mission: ${rest}`, 'info')
      updateWidget()
    },

    goal(rest) {
      if (!rest) { notify('Usage: /pai goal <title>', 'error'); return }
      const id = `g${state.goals.size}`
      state.goals.set(id, { id, title: rest, status: 'active', priority: 'p1', isc: [] })
      persist(pi, 'pai-goal', { id, title: rest, status: 'active' })
      notify(`✅ Goal ${id}: ${rest}`, 'info')
      updateWidget()
    },

    done(rest) {
      const goal = state.goals.get(rest.trim())
      if (!goal) { notify(`Goal "${rest.trim()}" not found`, 'error'); return }
      goal.status = 'completed'
      persist(pi, 'pai-goal-done', { goalId: rest.trim() })
      notify(`🎉 Completed: ${goal.title}`, 'info')
      updateWidget()
    },

    block(rest) {
      const goal = state.goals.get(rest.trim())
      if (!goal) { notify(`Goal "${rest.trim()}" not found`, 'error'); return }
      goal.status = 'blocked'
      persist(pi, 'pai-goal-blocked', { goalId: rest.trim() })
      notify(`🚫 Blocked: ${goal.title}`, 'warning')
      updateWidget()
    },

    challenge(rest) {
      if (!rest) { notify('Usage: /pai challenge <description>', 'error'); return }
      const id = `c${state.challenges.size}`
      state.challenges.set(id, { id, title: rest, severity: 'medium', affectedGoals: [] })
      persist(pi, 'pai-challenge', { id, title: rest })
      notify(`⚠️ Challenge ${id}: ${rest}`, 'warning')
      updateWidget()
    },

    learn(rest) {
      if (!rest) { notify('Usage: /pai learn <insight>', 'error'); return }
      state.learnings.push({ insight: rest, confidence: 0.8, category: 'domain', timestamp: new Date() })
      persist(pi, 'pai-learning', { insight: rest, category: 'domain' })
      notify(`📚 Learning: ${rest}`, 'info')
      updateWidget()
    },

    loop(rest) {
      const goal = rest || state.mission || 'unnamed'
      state.innerLoop = { phase: 'OBSERVE', goal, effort: 'standard', isc: [], data: {}, startTime: Date.now() }
      notify(`🔄 Algorithm started: ${goal} [OBSERVE]`, 'info')
      updateWidget()
    },

    effort(rest) {
      if (!state.innerLoop) { notify('No active loop', 'error'); return }
      const level = rest.toLowerCase() as EffortLevel
      if (!EFFORTS.includes(level)) { notify(`Usage: /pai effort ${EFFORTS.join('|')}`, 'error'); return }
      state.innerLoop.effort = level
      notify(`⚡ Effort: ${level}`, 'info')
      updateWidget()
    },

    isc(rest) {
      if (!state.innerLoop) { notify('No active loop', 'error'); return }
      if (!rest) { notify('Usage: /pai isc <8-12 word testable criterion>', 'error'); return }
      state.innerLoop.isc.push(rest)
      persist(pi, 'pai-isc', { criterion: rest, phase: state.innerLoop.phase })
      notify(`📋 ISC-${state.innerLoop.isc.length}: ${rest}`, 'info')
      updateWidget()
    },

    next(rest) {
      if (!state.innerLoop) { notify('No active loop. /pai loop <goal>', 'error'); return }
      if (rest) state.innerLoop.data[state.innerLoop.phase] = rest
      const idx = PHASES.indexOf(state.innerLoop.phase)

      if (idx < PHASES.length - 1) {
        state.innerLoop.phase = PHASES[idx + 1]
        notify(`→ ${state.innerLoop.phase}`, 'info')
      } else {
        state.iterationCount++
        const elapsed = Math.round((Date.now() - state.innerLoop.startTime) / 1000)
        persist(pi, 'pai-loop-complete', {
          goal: state.innerLoop.goal, iteration: state.iterationCount,
          effort: state.innerLoop.effort, isc: state.innerLoop.isc, data: state.innerLoop.data, elapsed,
        })
        notify(`✅ Loop #${state.iterationCount} complete (${elapsed}s)`, 'info')
        state.innerLoop = null
      }
      updateWidget()
    },

    template(rest) {
      const templates = loadTemplates()
      const name = rest.trim().toLowerCase()
      if (!name || !templates[name]) { notify(`Templates: ${Object.keys(templates).join(', ')}`, 'info'); return }
      const t = templates[name]
      state.mission = t.mission
      persist(pi, 'pai-mission', { mission: t.mission, template: name })
      for (const title of t.goals) {
        const id = `g${state.goals.size}`
        state.goals.set(id, { id, title, status: 'active', priority: 'p1', isc: [] })
        persist(pi, 'pai-goal', { id, title, status: 'active' })
      }
      for (const title of t.challenges) {
        const id = `c${state.challenges.size}`
        state.challenges.set(id, { id, title, severity: 'medium', affectedGoals: [] })
        persist(pi, 'pai-challenge', { id, title })
      }
      notify(`📋 Template "${name}": ${t.goals.length} goals, ${t.challenges.length} challenges`, 'info')
      updateWidget()
    },

    reset() {
      state.mission = null; state.goals.clear(); state.challenges.clear()
      state.learnings = []; state.ratings = []; state.innerLoop = null
      state.iterationCount = 0; state.ralphIteration = 0; state.ralphActive = false
      persist(pi, 'pai-reset', {})
      notify('🗑️ PAI state reset', 'warning')
      updateWidget()
    },

    status() {
      const goals = Array.from(state.goals.values())
      const challenges = Array.from(state.challenges.values())
      const avg = state.ratings.length ? (state.ratings.reduce((s, r) => s + r.score, 0) / state.ratings.length).toFixed(1) : 'none'

      let r = `# PAI Status\n\n**Mission:** ${state.mission || 'Not set'}\n`
      r += `**Iterations:** ${state.iterationCount} | **Avg Rating:** ${avg} (${state.ratings.length} signals)\n\n`

      r += `## Goals (${goals.length})\n`
      for (const g of goals) {
        const icon = g.status === 'completed' ? '✅' : g.status === 'blocked' ? '🚫' : '🎯'
        r += `- ${icon} **${g.id}** ${g.title} (${g.status})\n`
      }

      r += `\n## Challenges (${challenges.length})\n`
      for (const c of challenges) r += `- ⚠️ **${c.id}** ${c.title}\n`

      r += `\n## Recent Learnings\n`
      for (const l of state.learnings.slice(-5)) r += `- 📚 [${l.category}] ${l.insight}${l.fromRating ? ` (⭐${l.fromRating})` : ''}\n`

      if (state.innerLoop) {
        r += `\n## Active Loop\n**Phase:** ${state.innerLoop.phase} | **Effort:** ${state.innerLoop.effort} | **Goal:** ${state.innerLoop.goal}\n`
        for (const [i, c] of state.innerLoop.isc.entries()) r += `- ISC-${i + 1}: ${c}\n`
      }

      r += `\n## Damage Control\n${rules.bashToolPatterns.length} bash | ${rules.zeroAccessPaths.length} zero-access | ${rules.readOnlyPaths.length} read-only | ${rules.noDeletePaths.length} no-delete\n`
      pi.sendMessage({ customType: 'pai-status', content: r, display: true, details: undefined }, { triggerTurn: false })
    },
  }

  // ── /pai command ───────────────────────────────────────────────────────

  pi.registerCommand('pai', {
    description: 'PAI: /pai mission|goal|done|block|challenge|learn|loop|next|isc|effort|template|reset|status',
    handler: async (args, ctx) => {
      widgetCtx = ctx
      const parts = (args || '').trim().split(/\s+/)
      const sub = parts[0]?.toLowerCase()
      const rest = parts.slice(1).join(' ')
      const fn = paiCommands[sub]
      if (fn) fn(rest, ctx)
      else notify(`/pai ${Object.keys(paiCommands).join('|')}`, 'info')
    },
  })

  // ── /rate ──────────────────────────────────────────────────────────────

  pi.registerCommand('rate', {
    description: 'Rate last output 1-10: /rate <score> [context]',
    handler: async (args, ctx) => {
      widgetCtx = ctx
      const parts = (args || '').trim().split(/\s+/)
      const score = parseInt(parts[0], 10)
      const context = parts.slice(1).join(' ')

      if (isNaN(score) || score < 1 || score > 10) { notify('Usage: /rate <1-10> [context]', 'error'); return }

      state.ratings.push({ score, context, timestamp: new Date() })
      persist(pi, 'pai-rating', { score, context })

      if (score <= 3) {
        const l: Learning = { insight: `Low rating (${score}): ${context || 'below expectations'}`, confidence: 0.9, category: 'algorithm', timestamp: new Date(), fromRating: score }
        state.learnings.push(l)
        persist(pi, 'pai-learning', { insight: l.insight, category: 'algorithm', fromRating: score })
        notify(`⭐${score} — Learning captured`, 'warning')
      } else {
        notify(`⭐${score}${score >= 8 ? ' — Excellent!' : ''}`, 'info')
      }
      updateWidget()
    },
  })

  // ── /ralph ─────────────────────────────────────────────────────────────

  pi.registerCommand('ralph', {
    description: 'Ralph Wiggum iteration: /ralph <task> or /ralph stop',
    handler: async (args, ctx) => {
      widgetCtx = ctx
      const task = (args || '').trim()

      if (task.toLowerCase() === 'stop') {
        state.ralphActive = false
        notify(`🛑 Ralph stopped after ${state.ralphIteration} iterations`, 'warning')
        updateWidget()
        return
      }
      if (!task) { notify('Usage: /ralph <task> or /ralph stop', 'error'); return }

      state.ralphActive = true
      state.ralphIteration = 0
      notify(`🔄 Ralph starting: ${task}`, 'info')
      updateWidget()
      pi.sendMessage(
        { customType: 'pai-ralph', content: `[Ralph #${++state.ralphIteration}]\n\nTask: ${task}\n\nExecute this task. Say "RALPH_DONE" when finished.`, display: true, details: undefined },
        { triggerTurn: true },
      )
    },
  })

  pi.on('message_end', async (event, ctx) => {
    if (!state.ralphActive) return
    if (state.ralphIteration >= 50) { state.ralphActive = false; notify('🛑 Ralph: 50 limit', 'warning'); updateWidget(); return }
    const text = typeof event === 'object' && event !== null && 'text' in event ? String((event as Record<string, unknown>).text) : ''
    if (text.includes('RALPH_DONE')) { state.ralphActive = false; notify(`✅ Ralph done in ${state.ralphIteration}`, 'info'); updateWidget(); return }
    pi.sendMessage({ customType: 'pai-ralph', content: `[Ralph #${++state.ralphIteration}] Continue. Say "RALPH_DONE" when finished.`, display: true, details: undefined }, { triggerTurn: true })
    updateWidget()
  })

  // ── Tools ──────────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'pai_status',
    label: 'PAI Status',
    description: 'Get PAI status: mission, goals, challenges, learnings, loop, ratings.',
    parameters: Type.Object({}),
    execute: async () => ({
      details: undefined,
      content: [{ type: 'text' as const, text: JSON.stringify({
        mission: state.mission, goals: Array.from(state.goals.values()),
        challenges: Array.from(state.challenges.values()),
        learnings: state.learnings.slice(-10).map(l => ({ insight: l.insight, category: l.category })),
        innerLoop: state.innerLoop ? { phase: state.innerLoop.phase, effort: state.innerLoop.effort, goal: state.innerLoop.goal, isc: state.innerLoop.isc } : null,
        iterations: state.iterationCount,
        avgRating: state.ratings.length ? +(state.ratings.reduce((s, r) => s + r.score, 0) / state.ratings.length).toFixed(1) : null,
        ratingCount: state.ratings.length,
      }, null, 2) }],
    }),
  })

  pi.registerTool({
    name: 'pai_learn',
    label: 'PAI Learn',
    description: 'Record a learning/insight into PAI.',
    parameters: Type.Object({
      insight: Type.String({ description: 'The learning or insight' }),
      category: Type.Optional(Type.String({ description: 'algorithm|system|domain|process' })),
      confidence: Type.Optional(Type.Number({ description: '0-1' })),
    }),
    execute: async (_callId, args) => {
      state.learnings.push({ insight: args.insight, confidence: args.confidence ?? 0.8, category: args.category || 'domain', timestamp: new Date() })
      persist(pi, 'pai-learning', { insight: args.insight, category: args.category || 'domain' })
      updateWidget()
      return { details: undefined, content: [{ type: 'text' as const, text: `Learning [${args.category || 'domain'}]: ${args.insight}` }] }
    },
  })

  pi.registerTool({
    name: 'pai_rate',
    label: 'PAI Rate',
    description: 'Rate output quality 1-10. Low ratings auto-capture learnings.',
    parameters: Type.Object({
      score: Type.Number({ description: 'Rating 1-10' }),
      context: Type.Optional(Type.String({ description: 'Why' })),
    }),
    execute: async (_callId, args) => {
      const score = Math.max(1, Math.min(10, Math.round(args.score)))
      state.ratings.push({ score, context: args.context || '', timestamp: new Date() })
      persist(pi, 'pai-rating', { score, context: args.context })
      if (score <= 3) {
        state.learnings.push({ insight: `Low rating (${score}): ${args.context || 'below expectations'}`, confidence: 0.9, category: 'algorithm', timestamp: new Date(), fromRating: score })
        persist(pi, 'pai-learning', { insight: `Low rating (${score})`, category: 'algorithm', fromRating: score })
      }
      updateWidget()
      return { details: undefined, content: [{ type: 'text' as const, text: `Rated ⭐${score}${args.context ? ': ' + args.context : ''}` }] }
    },
  })

  // ── Damage Control ─────────────────────────────────────────────────────

  pi.on('tool_call', async (event, ctx) => {
    const { isToolCallEventType } = await import('@mariozechner/pi-coding-agent')

    if (isToolCallEventType('bash', event)) {
      const cmd = event.input.command || ''

      for (const rule of rules.bashToolPatterns) {
        try {
          if (new RegExp(rule.pattern).test(cmd)) {
            if (rule.ask) {
              const ok = await ctx.ui.confirm('🛡️ PAI', `${rule.reason}\n\n${cmd}\n\nAllow?`, { timeout: 30000 })
              if (!ok) { persist(pi, 'pai-dc', { cmd, reason: rule.reason, action: 'denied' }); ctx.abort(); return { block: true, reason: `🛑 ${rule.reason}. DO NOT retry.` } }
              return { block: false }
            }
            persist(pi, 'pai-dc', { cmd, reason: rule.reason, action: 'blocked' })
            ctx.abort()
            return { block: true, reason: `🛑 ${rule.reason}. DO NOT retry.` }
          }
        } catch { /* bad regex, skip */ }
      }

      // NOTE: zeroAccessPaths are NOT checked against bash commands.
      // Per Miessler's original PAI design, bash validation uses only regex patterns (above).
      // Path-based access control (zeroAccess, readOnly, noDelete) applies to file operations only (below).
    }

    if (isToolCallEventType('read', event) || isToolCallEventType('write', event) || isToolCallEventType('edit', event)) {
      const filePath = event.input.path || ''
      const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath)

      for (const zap of rules.zeroAccessPaths) {
        if (isPathMatch(resolved, zap, ctx.cwd)) {
          ctx.abort()
          return { block: true, reason: `🛑 zero-access: ${zap}. DO NOT retry.` }
        }
      }

      if (isToolCallEventType('write', event) || isToolCallEventType('edit', event)) {
        for (const rop of rules.readOnlyPaths) {
          if (isPathMatch(resolved, rop, ctx.cwd)) {
            ctx.abort()
            return { block: true, reason: `🛑 read-only: ${rop}. DO NOT modify.` }
          }
        }
      }
    }

    // noDeletePaths: block bash rm/del commands targeting protected paths
    if (isToolCallEventType('bash', event)) {
      const cmd = event.input.command || ''
      if (/\b(rm|del|rmdir|Remove-Item)\b/i.test(cmd)) {
        for (const ndp of rules.noDeletePaths) {
          const clean = ndp.replace(/^~\//, '').replace(/^\*/, '')
          if (clean && cmd.includes(clean)) {
            persist(pi, 'pai-dc', { cmd, reason: `no-delete: ${ndp}`, action: 'blocked' })
            ctx.abort()
            return { block: true, reason: `🛑 no-delete: ${ndp}. DO NOT retry.` }
          }
        }
      }
    }

    return { block: false }
  })

  // ── Session lifecycle ──────────────────────────────────────────────────

  pi.on('session_start', async (_event, ctx) => {
    widgetCtx = ctx
    rules = loadDamageRules(ctx.cwd)
    updateWidget()
    const n = rules.bashToolPatterns.length + rules.zeroAccessPaths.length + rules.readOnlyPaths.length + rules.noDeletePaths.length
    ctx.ui.notify(`🧠 π-PAI v3.1 | ${n ? n + ' rules' : 'no rules'} | /pai /ralph /rate`, 'info')
  })
}
