import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { Journal, JournalStore } from './policy.js'

export function defaultJournalFilePath(): string {
  return join(homedir(), '.hyperpay', 'spend.json')
}

export function fileJournal(path: string): JournalStore {
  return {
    read(): Journal {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as Journal
      } catch {
        return {}
      }
    },
    write(journal: Journal): void {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(journal, null, 2), { mode: 0o600 })
    },
  }
}
