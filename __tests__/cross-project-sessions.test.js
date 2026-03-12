import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getProjectStateDir,
  loadSession,
  saveSession,
  listActiveSessions,
  multipleSessionsError,
  findSessionRecord,
} from '../index.js';

function makeSession(project, id, topic) {
  return {
    id,
    project,
    type: 'deliberation',
    topic,
    lang: 'ko',
    status: 'active',
    current_round: 1,
    max_rounds: 3,
    current_speaker: 'codex',
    speakers: ['codex', 'claude'],
    participant_profiles: [
      { speaker: 'codex', type: 'cli' },
      { speaker: 'claude', type: 'cli' },
    ],
    log: [],
    created: '2026-03-13T00:00:00.000Z',
    updated: '2026-03-13T00:00:00.000Z',
  };
}

const createdProjects = new Set();

function trackProject(project) {
  createdProjects.add(project);
  return project;
}

afterEach(() => {
  for (const project of createdProjects) {
    fs.rmSync(getProjectStateDir(project), { recursive: true, force: true });
  }
  createdProjects.clear();
});

describe('cross-project deliberation state', () => {
  it('loads a session from another project when the id is explicit', () => {
    const project = trackProject(`test-cross-load-${Date.now()}`);
    const session = makeSession(project, `session-${Date.now()}`, 'Cross project load');
    saveSession(session);

    expect(loadSession(session.id)).toMatchObject({
      id: session.id,
      project,
      topic: 'Cross project load',
    });
  });

  it('lists active sessions across project state directories', () => {
    const suffix = Date.now();
    const projectA = trackProject(`test-cross-list-a-${suffix}`);
    const projectB = trackProject(`test-cross-list-b-${suffix}`);
    saveSession(makeSession(projectA, `session-a-${suffix}`, 'Topic A'));
    saveSession(makeSession(projectB, `session-b-${suffix}`, 'Topic B'));

    const active = listActiveSessions().filter(session =>
      session.id === `session-a-${suffix}` || session.id === `session-b-${suffix}`
    );

    expect(active).toHaveLength(2);
    expect(active.map(session => session.project).sort()).toEqual([projectA, projectB].sort());
  });

  it('includes project names in multi-session guidance', () => {
    const suffix = Date.now();
    const projectA = trackProject(`test-cross-error-a-${suffix}`);
    const projectB = trackProject(`test-cross-error-b-${suffix}`);
    saveSession(makeSession(projectA, `session-c-${suffix}`, 'Topic C'));
    saveSession(makeSession(projectB, `session-d-${suffix}`, 'Topic D'));

    const message = multipleSessionsError();
    expect(message).toContain(`[${projectA}]`);
    expect(message).toContain(`[${projectB}]`);
  });

  it('finds the owning project for a foreign session id', () => {
    const project = trackProject(`test-cross-find-${Date.now()}`);
    const session = makeSession(project, `session-find-${Date.now()}`, 'Topic Find');
    saveSession(session);

    expect(findSessionRecord(session.id)).toMatchObject({
      project,
      state: expect.objectContaining({ id: session.id }),
      file: path.join(getProjectStateDir(project), 'sessions', `${session.id}.json`),
    });
  });
});
