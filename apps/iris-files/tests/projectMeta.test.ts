import { describe, expect, it } from 'vitest';
import { parseProjectMeta, upsertProjectForkedFrom } from '../src/stores/projectMeta';

describe('parseProjectMeta', () => {
  it('parses project about and homepage from the [project] section', () => {
    const parsed = parseProjectMeta([
      '[project]',
      'about = "Content-addressed git on hashtree."',
      'homepage = "https://git.iris.to"',
      '',
    ].join('\n'));

    expect(parsed).toEqual({
      about: 'Content-addressed git on hashtree.',
      homepage: 'https://git.iris.to',
    });
  });

  it('accepts description and website aliases at the top level', () => {
    const parsed = parseProjectMeta([
      'description = "Portable repo metadata."',
      'website = "docs.example.com/project"',
      '',
    ].join('\n'));

    expect(parsed).toEqual({
      about: 'Portable repo metadata.',
      homepage: 'docs.example.com/project',
    });
  });

  it('parses fork origin metadata from the project section', () => {
    const parsed = parseProjectMeta([
      '[project]',
      'forked_from = "htree://npub1source/public/demo"',
      '',
    ].join('\n'));

    expect(parsed).toEqual({
      forkedFrom: 'htree://npub1source/public/demo',
    });
  });
});

describe('upsertProjectForkedFrom', () => {
  it('adds a project section when metadata is missing', () => {
    expect(upsertProjectForkedFrom('', 'htree://npub1source/demo')).toBe([
      '[project]',
      'forked_from = "htree://npub1source/demo"',
      '',
    ].join('\n'));
  });

  it('updates an existing fork origin in place', () => {
    expect(upsertProjectForkedFrom([
      '[project]',
      'about = "Demo"',
      'forked_from = "htree://npub1old/demo"',
      '',
    ].join('\n'), 'htree://npub1new/demo')).toBe([
      '[project]',
      'about = "Demo"',
      'forked_from = "htree://npub1new/demo"',
      '',
    ].join('\n'));
  });

  it('preserves other sections when inserting fork origin metadata', () => {
    expect(upsertProjectForkedFrom([
      '[project]',
      'about = "Demo"',
      '',
      '[ci]',
      'enabled = true',
      '',
    ].join('\n'), 'htree://npub1source/demo')).toBe([
      '[project]',
      'about = "Demo"',
      '',
      'forked_from = "htree://npub1source/demo"',
      '[ci]',
      'enabled = true',
      '',
    ].join('\n'));
  });
});
