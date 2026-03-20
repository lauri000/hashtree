import { describe, expect, it } from 'vitest';
import { createPublishPlan } from '../scripts/publish-iris-build.mjs';

describe('publish-iris-build', () => {
  it('supports docs, git, and maps portable publish plans', () => {
    expect(createPublishPlan('docs')).toMatchObject({
      name: 'docs',
      appName: 'Iris Docs',
      distDir: 'dist-docs',
      treeName: 'docs',
    });

    expect(createPublishPlan('git')).toMatchObject({
      name: 'git',
      appName: 'Iris Git',
      distDir: 'iris-git',
      treeName: 'git',
    });

    expect(createPublishPlan('maps')).toMatchObject({
      name: 'maps',
      appName: 'Iris Maps',
      distDir: 'dist-maps',
      treeName: 'maps',
    });
  });

  it('publishes the selected tree name from the matching dist directory', () => {
    expect(createPublishPlan('video').command).toEqual([
      'cargo',
      'run',
      '--manifest-path',
      expect.stringContaining('/rust/Cargo.toml'),
      '-p',
      'hashtree-cli',
      '--bin',
      'htree',
      '--',
      'add',
      '.',
      '--publish',
      'video',
    ]);
    expect(createPublishPlan('video').distDir).toMatch(/dist-video$/);
  });
});
