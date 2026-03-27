import { describe, expect, it } from 'vitest';
import {
  getAutoReloadStorageKey,
  isMenuHidden,
  readHashBooleanParam,
  setAutoReload,
  setHashRouteParam,
  setMenuHidden,
} from '../src/lib/runtimeUi';

describe('runtime UI helpers', () => {
  it('detects hidden menu flags from the route query', () => {
    expect(isMenuHidden('#/index.html?menu=0')).toBe(true);
    expect(isMenuHidden('#/index.html?menu=false')).toBe(true);
    expect(isMenuHidden('#/index.html?menu=off')).toBe(true);
    expect(isMenuHidden('#/index.html?menu=hidden')).toBe(true);
    expect(isMenuHidden('#/index.html')).toBe(false);
  });

  it('updates route query params without disturbing the path or existing key params', () => {
    expect(setHashRouteParam('#/index.html?k=abc', 'menu', '0')).toBe('#/index.html?k=abc&menu=0');
    expect(setHashRouteParam('#/npub/tree/index.html', 'menu', '0')).toBe('#/npub/tree/index.html?menu=0');
    expect(setHashRouteParam('#/index.html?k=abc&menu=0', 'menu', null)).toBe('#/index.html?k=abc');
  });

  it('encodes menu hiding as a shareable hash param', () => {
    expect(setMenuHidden('#/index.html?k=abc', true)).toBe('#/index.html?k=abc&menu=0');
    expect(setMenuHidden('#/index.html?k=abc&menu=0', false)).toBe('#/index.html?k=abc');
  });

  it('reads boolean route params without conflating missing and false values', () => {
    expect(readHashBooleanParam('#/index.html?reload=1', 'reload')).toBe(true);
    expect(readHashBooleanParam('#/index.html?reload=true', 'reload')).toBe(true);
    expect(readHashBooleanParam('#/index.html?reload=0', 'reload')).toBe(false);
    expect(readHashBooleanParam('#/index.html?reload=off', 'reload')).toBe(false);
    expect(readHashBooleanParam('#/index.html', 'reload')).toBeNull();
    expect(readHashBooleanParam('#/index.html?reload=maybe', 'reload')).toBeNull();
  });

  it('encodes auto-reload as an explicit shareable hash override when present', () => {
    expect(setAutoReload('#/index.html?k=abc', true)).toBe('#/index.html?k=abc&reload=1');
    expect(setAutoReload('#/index.html?k=abc', false)).toBe('#/index.html?k=abc&reload=0');
    expect(setAutoReload('#/index.html?k=abc&reload=0', null)).toBe('#/index.html?k=abc');
  });

  it('uses per-site keys for mutable and immutable auto-reload preferences', () => {
    expect(getAutoReloadStorageKey({
      kind: 'mutable',
      siteKey: 'pilot',
      title: 'Midi',
      npub: 'npub1example',
      treeName: 'enshittifier',
      entryPath: 'index.html',
    })).toBe('iris-sites:auto-reload:npub1example/enshittifier');

    expect(getAutoReloadStorageKey({
      kind: 'immutable',
      siteKey: 'pilot',
      title: 'Pinned',
      nhash: 'nhash1example',
      entryPath: 'index.html',
    })).toBe('iris-sites:auto-reload:nhash1example');
  });
});
