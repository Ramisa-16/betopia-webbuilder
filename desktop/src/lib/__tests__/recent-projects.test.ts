import { beforeEach, describe, expect, it } from 'vitest'
import { getRecentProjectPaths } from '../recent-projects'

describe('recent project paths', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('merges v2 and legacy recent project lists without duplicates', () => {
    localStorage.setItem('betopia_recent_projects_v2', JSON.stringify([
      { path: '/projects/alpha' },
      { path: '/projects/beta' },
    ]))
    localStorage.setItem('betopia_recent_paths', JSON.stringify([
      '/projects/beta',
      '/projects/gamma',
    ]))

    expect(getRecentProjectPaths()).toEqual([
      '/projects/alpha',
      '/projects/beta',
      '/projects/gamma',
    ])
  })

  it('returns an empty list when storage is unavailable or malformed', () => {
    localStorage.setItem('betopia_recent_projects_v2', 'not-json')
    localStorage.setItem('betopia_recent_paths', 'also-not-json')

    expect(getRecentProjectPaths()).toEqual([])
  })
})
