import { CAVEMAN_CLIENT_COMMAND } from './builtin-skills'
import { buildSkillPrompt, buildSkillVisibleText } from './skill-routing'

export type CavemanIntensity = 'lite' | 'full' | 'ultra'

export type CavemanSubmitAction =
  | { kind: 'send' | 'queue'; enabled: true; intensity: CavemanIntensity; visibleText: string; agentPrompt: string }
  | { kind: 'local-note'; enabled: false; intensity: CavemanIntensity }

export function resolveTypedCavemanSubmitAction(
  text: string,
  isBusy: boolean,
  currentEnabled: boolean,
  currentIntensity: CavemanIntensity,
): CavemanSubmitAction | null {
  const match = text.trim().match(/^\/caveman(?:\s+(lite|full|ultra|off))?$/i)
  if (!match) return null

  const arg = (match[1] ?? '').toLowerCase()
  let enabled = arg === 'off' ? false : true
  const intensity: CavemanIntensity =
    arg === 'lite' || arg === 'full' || arg === 'ultra'
      ? arg
      : currentIntensity

  if (!arg) enabled = !currentEnabled
  if (!enabled) return { kind: 'local-note', enabled: false, intensity }

  const task = `/caveman ${intensity}`
  return {
    kind: isBusy ? 'queue' : 'send',
    enabled: true,
    intensity,
    visibleText: buildSkillVisibleText(CAVEMAN_CLIENT_COMMAND, task),
    agentPrompt: buildSkillPrompt(
      {
        ...CAVEMAN_CLIENT_COMMAND,
        body: CAVEMAN_CLIENT_COMMAND.activationBody,
      },
      task,
    ),
  }
}
