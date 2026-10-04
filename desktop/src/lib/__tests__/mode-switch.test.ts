import { describe, expect, it } from 'vitest'
import { shouldPromptModeSwitch, shouldSkipPlanning, shouldUsePlanningForPrompt } from '../mode-switch'

describe('mode switch intent', () => {
  it('prompts for a mode change on start build', () => {
    expect(shouldPromptModeSwitch('start build')).toBe(true)
    expect(shouldPromptModeSwitch('Start building now')).toBe(true)
  })

  it('prompts for a mode change on build-like edit tasks', () => {
    expect(shouldPromptModeSwitch('add a testimonial to the page')).toBe(true)
    expect(shouldPromptModeSwitch('edit frontend/src/data/sections.ts')).toBe(true)
  })

  it('does not prompt for unrelated messages', () => {
    expect(shouldPromptModeSwitch('hello there')).toBe(false)
    expect(shouldPromptModeSwitch('what is the status?')).toBe(false)
  })

  it('keeps the existing planning heuristics and skip phrases', () => {
    expect(shouldUsePlanningForPrompt('build a dashboard app')).toBe(true)
    expect(shouldSkipPlanning('disable orchestration')).toBe(true)
  })
})
