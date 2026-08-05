import { beforeEach, describe, expect, it } from 'vitest'
import {
  ccHref,
  ccTabFromPath,
  getLastCcTab,
  getLastProjectTab,
  projectHref,
  projectTabFromPath,
  projectViewFromPath,
  rememberView,
} from './lastView'

beforeEach(() => localStorage.clear())

describe('projectTabFromPath', () => {
  it('maps each project tab route to its tab', () => {
    expect(projectTabFromPath('/projects/7')).toBe('board')
    expect(projectTabFromPath('/projects/7/dashboard')).toBe('dashboard')
    expect(projectTabFromPath('/projects/7/storyboards')).toBe('storyboards')
    expect(projectTabFromPath('/projects/7/git')).toBe('git')
    expect(projectTabFromPath('/projects/7/files')).toBe('files')
    expect(projectTabFromPath('/projects/7/terminal')).toBe('terminal')
    expect(projectTabFromPath('/projects/7/settings')).toBe('settings')
  })

  it('remembers the tab, never the deep id', () => {
    expect(projectTabFromPath('/projects/7/storyboards/3')).toBe('storyboards')
    expect(projectTabFromPath('/projects/7/tasks/12')).toBe('board')
    expect(projectTabFromPath('/projects/7/create-task')).toBe('board')
  })

  it('is null for anything that is not a project route', () => {
    for (const p of ['/', '/inbox', '/settings', '/terminal', '/cc', '/projects']) {
      expect(projectTabFromPath(p)).toBeNull()
    }
  })
})

describe('projectViewFromPath', () => {
  it('keeps the project id alongside the tab', () => {
    expect(projectViewFromPath('/projects/7')).toEqual({ id: 7, tab: 'board' })
    expect(projectViewFromPath('/projects/9/files')).toEqual({ id: 9, tab: 'files' })
    expect(projectViewFromPath('/projects/12/storyboards/3')).toEqual({
      id: 12,
      tab: 'storyboards',
    })
    expect(projectViewFromPath('/projects/7/tasks/12')).toEqual({ id: 7, tab: 'board' })
  })

  it('is null for anything that is not a project route', () => {
    for (const p of ['/', '/inbox', '/cc', '/projects']) {
      expect(projectViewFromPath(p)).toBeNull()
    }
  })
})

describe('ccTabFromPath', () => {
  it('maps each cc route to its sub-tab', () => {
    expect(ccTabFromPath('/cc')).toBe('overview')
    expect(ccTabFromPath('/cc/skills-agents')).toBe('skills-agents')
    expect(ccTabFromPath('/cc/projects')).toBe('projects')
    expect(ccTabFromPath('/cc/sessions')).toBe('sessions')
  })

  it('treats the session drill-downs as the Sessions tab', () => {
    const id = 'e5d7a1c2-0000-4000-8000-abcdef123456'
    expect(ccTabFromPath(`/cc/sessions/${id}`)).toBe('sessions')
    expect(ccTabFromPath(`/cc/sessions/${id}/timeline`)).toBe('sessions')
    expect(ccTabFromPath(`/cc/sessions/${id}/graph`)).toBe('sessions')
  })

  it('is null for anything that is not a cc route, root included', () => {
    for (const p of ['/', '/inbox', '/settings', '/terminal', '/projects/7']) {
      expect(ccTabFromPath(p)).toBeNull()
    }
  })
})

describe('rememberView', () => {
  it('records the project tab and leaves the cc memory alone', () => {
    rememberView('/cc/sessions')
    rememberView('/projects/7/files')
    expect(getLastProjectTab(7)).toBe('files')
    expect(getLastCcTab()).toBe('sessions')
  })

  it('keeps one tab per project', () => {
    rememberView('/projects/7/terminal')
    rememberView('/projects/9/files')
    expect(getLastProjectTab(7)).toBe('terminal')
    expect(getLastProjectTab(9)).toBe('files')
    expect(getLastProjectTab(11)).toBe('board')
  })

  it('records a return to the board', () => {
    rememberView('/projects/7/files')
    rememberView('/projects/7')
    expect(getLastProjectTab(7)).toBe('board')
  })

  it('drops 694s single-tab key on the first write', () => {
    localStorage.setItem('mesa-last-project-tab', 'files')
    rememberView('/projects/7/git')
    expect(localStorage.getItem('mesa-last-project-tab')).toBeNull()
  })

  it('records nothing for non-project, non-cc routes', () => {
    rememberView('/projects/7/git')
    rememberView('/cc/projects')
    for (const p of ['/inbox', '/settings', '/terminal', '/']) rememberView(p)
    expect(getLastProjectTab(7)).toBe('git')
    expect(getLastCcTab()).toBe('projects')
  })
})

describe('stored value', () => {
  it('falls back to board/overview when absent, unknown or corrupt', () => {
    expect(getLastProjectTab(7)).toBe('board')
    expect(getLastCcTab()).toBe('overview')
    localStorage.setItem('mesa-last-cc-tab', '{"nope":1}')
    expect(getLastCcTab()).toBe('overview')
    for (const bad of ['', 'wat', 'null', '[]', '"files"', '{"7":5}', '{"7":"wat"}']) {
      localStorage.setItem('mesa-last-project-tabs', bad)
      expect(getLastProjectTab(7)).toBe('board')
    }
  })

  it('keeps the readable entries of a partly-corrupt map', () => {
    localStorage.setItem('mesa-last-project-tabs', '{"7":"files","9":{"x":1}}')
    expect(getLastProjectTab(7)).toBe('files')
    expect(getLastProjectTab(9)).toBe('board')
  })
})

describe('hrefs', () => {
  it('emits the bare project route for board, the tab segment otherwise', () => {
    expect(projectHref(7)).toBe('#/projects/7')
    rememberView('/projects/1/files')
    expect(projectHref(7)).toBe('#/projects/7')
    rememberView('/projects/7/files')
    expect(projectHref(7)).toBe('#/projects/7/files')
    rememberView('/projects/7/storyboards/3')
    expect(projectHref(7)).toBe('#/projects/7/storyboards')
  })

  it('emits #/cc for overview, the sub-tab otherwise', () => {
    expect(ccHref()).toBe('#/cc')
    rememberView('/cc/sessions/abc/timeline')
    expect(ccHref()).toBe('#/cc/sessions')
  })
})
