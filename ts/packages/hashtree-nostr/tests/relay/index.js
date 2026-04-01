/**
 * Simple in-memory Nostr relay for tests.
 */
import http from 'http'
import fs from 'fs'
import { matchFilters } from 'nostr-tools'
import { WebSocketServer } from 'ws'

const DEBUG = process.env.RELAY_DEBUG === '1'
const log = (...args) => {
  if (!DEBUG) return
  const msg = args.map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : arg)).join(' ')
  const line = `${new Date().toISOString()} ${msg}\n`
  fs.appendFile('/tmp/relay-debug.log', line, () => {})
  console.log(...args)
}

const PORT = process.env.RELAY_PORT || 4736
const HANDSHAKE_DELAY_MS = Number(process.env.RELAY_HANDSHAKE_DELAY_MS || 0)

const server = http.createServer((req, res) => {
  if (req.url === '/' && req.headers.accept === 'application/nostr+json') {
    res.writeHead(200, {
      'Content-Type': 'application/nostr+json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    })

    res.end(JSON.stringify({
      name: 'hashtree-test-relay',
      description: 'Local relay for tests',
      software: 'https://github.com/coracle-social/bucket',
      supported_nips: [1, 11],
    }))
  } else {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    })
    res.end('hashtree-test-relay')
  }
})

const namespaces = new Map()

function getNamespace(url) {
  if (!url) return '/'
  let value = url.split('?')[0] || '/'
  if (value !== '/' && value.endsWith('/')) {
    value = value.replace(/\/+$/, '')
  }
  return value === '' ? '/' : value
}

function getNamespaceState(namespace) {
  let state = namespaces.get(namespace)
  if (!state) {
    state = { gsubs: new Map(), events: new Map() }
    namespaces.set(namespace, state)
  }
  return state
}

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const handleUpgrade = () => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  }

  if (HANDSHAKE_DELAY_MS > 0) {
    setTimeout(handleUpgrade, HANDSHAKE_DELAY_MS)
  } else {
    handleUpgrade()
  }
})

setInterval(() => {
  for (const state of namespaces.values()) {
    state.events.clear()
  }
}, 300_000)

wss.on('connection', (socket, req) => {
  const namespace = getNamespace(req?.url)
  const { gsubs, events } = getNamespaceState(namespace)
  const connectionId = Math.random().toString().slice(2)
  const localSubscriptions = new Map()
  log(`[relay] New connection: ${connectionId} ns=${namespace}`)

  const send = (message) => {
    try {
      socket.send(JSON.stringify(message))
    } catch {
    }
  }

  const makeCallback = (localSubId, filters) => (event) => {
    if (matchFilters(filters, event)) {
      log(`[relay] MATCH sub=${localSubId} event.kind=${event.kind} id=${event.id?.slice(0, 8)}`)
      send(['EVENT', localSubId, event])
    }
  }

  socket.on('message', (message) => {
    try {
      const parsed = JSON.parse(message)

      if (parsed[0] === 'EVENT') {
        const event = parsed[1]
        log(`[relay] EVENT kind=${event.kind} pubkey=${event.pubkey?.slice(0, 8)}`)
        events.set(event.id, event)

        for (const callback of gsubs.values()) {
          callback(event)
        }

        send(['OK', event.id, true, ''])
      }

      if (parsed[0] === 'REQ') {
        const localSubId = parsed[1]
        const globalSubId = `${connectionId}:${localSubId}`
        const filters = parsed.slice(2)

        localSubscriptions.set(localSubId, globalSubId)
        gsubs.set(globalSubId, makeCallback(localSubId, filters))

        for (const event of events.values()) {
          if (matchFilters(filters, event)) {
            send(['EVENT', localSubId, event])
          }
        }

        send(['EOSE', localSubId])
      }

      if (parsed[0] === 'CLOSE') {
        const localSubId = parsed[1]
        const globalSubId = `${connectionId}:${localSubId}`
        localSubscriptions.delete(localSubId)
        gsubs.delete(globalSubId)
      }
    } catch {
    }
  })

  socket.on('close', () => {
    for (const globalSubId of localSubscriptions.values()) {
      gsubs.delete(globalSubId)
    }

    localSubscriptions.clear()
  })
})

const HOST = process.env.TEST_RELAY_HOST || '127.0.0.1'
server.listen(PORT, HOST, () => {
  log(`[test-relay] Running on ws://localhost:${PORT}`)
})
