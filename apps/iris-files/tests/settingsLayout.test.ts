import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd(), 'src', 'components', 'settings');
const settingsLayoutSource = fs.readFileSync(path.join(root, 'SettingsLayout.svelte'), 'utf8');
const networkSettingsSource = fs.readFileSync(path.join(root, 'NetworkSettings.svelte'), 'utf8');
const serversSettingsSource = fs.readFileSync(path.join(root, 'ServersSettings.svelte'), 'utf8');

describe('shared settings layout', () => {
  it('uses a single Network tab for server and peer settings', () => {
    expect(settingsLayoutSource).toContain("{ id: 'network', label: 'Network'");
    expect(settingsLayoutSource).not.toContain("{ id: 'servers'");
    expect(settingsLayoutSource).not.toContain("{ id: 'p2p'");
    expect(settingsLayoutSource).toContain('<NetworkSettings />');
  });

  it('keeps the old servers and p2p routes on the network tab fallback path', () => {
    expect(settingsLayoutSource).toContain("if (path.startsWith('/settings/storage')) return 'storage';");
    expect(settingsLayoutSource).toContain("if (path.startsWith('/settings/app')) return 'app';");
    expect(settingsLayoutSource).toContain("return 'network'; // default");
    expect(networkSettingsSource).toContain('<ServersSettings embedded={true} />');
    expect(networkSettingsSource).toContain('<P2PSettings embedded={true} />');
  });

  it('shows embedded daemon transport and upstream relays inside one relay section', () => {
    expect(serversSettingsSource).toContain('Relays');
    expect(serversSettingsSource).toContain('Configured upstream relays');
    expect(serversSettingsSource).not.toContain('Local Transport (');
  });
});
