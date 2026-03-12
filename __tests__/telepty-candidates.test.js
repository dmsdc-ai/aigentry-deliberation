import { describe, it, expect } from 'vitest';
import {
  mapParticipantProfiles,
  formatSpeakerCandidatesReport,
} from '../index.js';

describe('telepty speaker candidates', () => {
  it('maps telepty candidates to lightweight participant profiles', () => {
    const profiles = mapParticipantProfiles(
      ['aigentry-registry-001'],
      [{
        speaker: 'aigentry-registry-001',
        type: 'telepty',
        telepty_session_id: 'aigentry-registry-001',
        telepty_host: '127.0.0.1',
        command: 'claude',
        cwd: '/Users/test/projects/aigentry-registry',
        runtime_pid: 93330,
        runtime_tty: 'ttys000',
      }],
      {}
    );

    expect(profiles).toEqual([{
      speaker: 'aigentry-registry-001',
      type: 'telepty',
      command: 'claude',
      telepty_session_id: 'aigentry-registry-001',
      telepty_host: '127.0.0.1',
      runtime_pid: 93330,
    }]);
  });

  it('renders telepty sessions in the candidate report with lightweight locators', () => {
    const text = formatSpeakerCandidatesReport({
      candidates: [{
        speaker: 'aigentry-registry-001',
        type: 'telepty',
        telepty_session_id: 'aigentry-registry-001',
        telepty_host: '127.0.0.1',
        command: 'claude',
        cwd: '/Users/test/projects/aigentry-registry',
        runtime_pid: 93330,
        runtime_tty: 'ttys000',
      }],
      browserNote: null,
    });

    expect(text).toContain('### Telepty Sessions');
    expect(text).toContain('aigentry-registry-001');
    expect(text).toContain('pid: 93330');
    expect(text).toContain('/Users/test/projects/aigentry-registry');
  });
});
