import { describe, expect, it } from 'vitest';
import { parseProjectMeta } from '../src/stores/projectMeta';

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
});
