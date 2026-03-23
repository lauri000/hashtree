import { afterEach, describe, expect, it } from 'vitest';
import {
  shouldOpenSourceCodeLinkInNewTab,
  setAppType,
  shouldShowGenericFileBrowser,
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

  it('hides the generic file browser and keeps source links in-tab for git', () => {
    setAppType('git');
    expect(shouldShowGenericFileBrowser()).toBe(false);
    expect(shouldOpenSourceCodeLinkInNewTab()).toBe(false);
  });

  it('keeps the generic file browser and external source links for non-git apps', () => {
    setAppType('files');
    expect(shouldShowGenericFileBrowser()).toBe(true);
    expect(shouldOpenSourceCodeLinkInNewTab()).toBe(true);

    setAppType('docs');
    expect(shouldShowGenericFileBrowser()).toBe(true);
    expect(shouldOpenSourceCodeLinkInNewTab()).toBe(true);
  });
});
