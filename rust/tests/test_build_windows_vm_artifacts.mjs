import test from 'node:test'
import assert from 'node:assert/strict'

import {
  autoDetectWindowsVmName,
  defaultSharedWindowsPath,
  parseArgs,
} from '../scripts/build_windows_vm_artifacts.mjs'

test('defaultSharedWindowsPath maps home-relative paths into Parallels shared folders', () => {
  assert.equal(
    defaultSharedWindowsPath('/Users/sirius/src/hashtree', '/Users/sirius'),
    'C:\\Mac\\Home\\src\\hashtree',
  )
  assert.equal(defaultSharedWindowsPath('/tmp/hashtree', '/Users/sirius'), null)
})

test('autoDetectWindowsVmName returns the single running Windows VM', () => {
  const listing = `UUID                                    STATUS       IP_ADDR         NAME
{11111111-1111-1111-1111-111111111111}  running      -               Windows 11
{22222222-2222-2222-2222-222222222222}  stopped      -               Linux`
  assert.equal(autoDetectWindowsVmName(listing), 'Windows 11')
})

test('autoDetectWindowsVmName requires a unique running Windows VM', () => {
  const listing = `UUID                                    STATUS       IP_ADDR         NAME
{11111111-1111-1111-1111-111111111111}  running      -               Windows 11
{33333333-3333-3333-3333-333333333333}  running      -               Windows Dev`
  assert.equal(autoDetectWindowsVmName(listing), null)
})

test('parseArgs reads overrides and defaults', () => {
  const parsed = parseArgs([
    '--output-dir',
    '/tmp/out',
    '--vm-name',
    'Windows 11',
    '--shared-repo-path',
    'C:\\Mac\\Home\\src\\hashtree',
    '--guest-repo-path',
    'C:\\Users\\sirius\\src\\hashtree',
  ])

  assert.deepEqual(parsed, {
    outputDir: '/tmp/out',
    vmName: 'Windows 11',
    sharedRepoPath: 'C:\\Mac\\Home\\src\\hashtree',
    guestRepoPath: 'C:\\Users\\sirius\\src\\hashtree',
    help: false,
  })
})
