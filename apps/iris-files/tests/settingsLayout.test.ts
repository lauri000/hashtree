import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd(), 'src', 'components', 'settings');
const settingsLayoutSource = fs.readFileSync(path.join(root, 'SettingsLayout.svelte'), 'utf8');
const networkSettingsSource = fs.readFileSync(path.join(root, 'NetworkSettings.svelte'), 'utf8');
const serversSettingsSource = fs.readFileSync(path.join(root, 'ServersSettings.svelte'), 'utf8');

describe('shared settings layout', () => {
  it('uses a single plain Network tab for server and peer settings', () => {
    expect(settingsLayoutSource).toContain("id: 'app'");
    expect(settingsLayoutSource).toContain("label: 'App'");
    expect(settingsLayoutSource).toContain("id: 'network'");
    expect(settingsLayoutSource).toContain("label: 'Network'");
    expect(settingsLayoutSource).not.toContain('Account tools, build info, and refresh actions');
    expect(settingsLayoutSource).not.toContain('Cache limits, local storage, and republish tools');
    expect(settingsLayoutSource).not.toContain('Relays, file servers, and peer transport settings');
    expect(settingsLayoutSource).not.toContain('App behavior, storage, and network configuration for this shell.');
    expect(settingsLayoutSource).not.toContain('const settingsGroups =');
    expect(settingsLayoutSource).not.toContain('mx-auto w-full max-w-md');
    expect(settingsLayoutSource).not.toContain('mx-auto w-full max-w-4xl');
    expect(settingsLayoutSource).not.toContain("{ id: 'servers'");
    expect(settingsLayoutSource).not.toContain("{ id: 'p2p'");
    expect(settingsLayoutSource).toContain('<NetworkSettings />');
  });

  it('keeps the old servers and p2p routes on the network tab fallback path', () => {
    expect(settingsLayoutSource).toContain("if (path.startsWith('/settings/storage')) return 'storage';");
    expect(settingsLayoutSource).toContain("if (path.startsWith('/settings/network')) return 'network';");
    expect(settingsLayoutSource).toContain("if (path.startsWith('/settings/app')) return 'app';");
    expect(settingsLayoutSource).toContain("return DEFAULT_TAB;");
    expect(networkSettingsSource).toContain('<TransportUsageSettings embedded={true} />');
    expect(networkSettingsSource).toContain('<ServersSettings embedded={true} />');
    expect(networkSettingsSource).toContain('<P2PSettings embedded={true} />');
  });

  it('shows embedded daemon transport and upstream relays inside one relay section', () => {
    expect(serversSettingsSource).toContain('Relays');
    expect(serversSettingsSource).toContain('Configured upstream relays');
    expect(serversSettingsSource).not.toContain('Local Transport (');
  });
});
