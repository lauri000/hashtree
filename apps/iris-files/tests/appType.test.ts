import { afterEach, describe, expect, it } from 'vitest';
import {
  setAppType,
  supportsDocumentFeatures,
  supportsGitFeatures,
} from '../src/appType';

afterEach(() => {
  setAppType('files');
});

describe('app capabilities', () => {
  it('keeps the files app limited to generic file features', () => {
    setAppType('files');
    expect(supportsDocumentFeatures()).toBe(false);
    expect(supportsGitFeatures()).toBe(false);
  });

  it('enables document features only for docs', () => {
    setAppType('docs');
    expect(supportsDocumentFeatures()).toBe(true);
    expect(supportsGitFeatures()).toBe(false);
  });

  it('enables git features only for git', () => {
    setAppType('git');
    expect(supportsDocumentFeatures()).toBe(false);
    expect(supportsGitFeatures()).toBe(true);
  });
});
