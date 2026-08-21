import { keypairSigner } from '@magicblock-labs/hyperpay-solana'
import { fileJournal, defaultJournalFilePath } from './journal-fs.js'
import { setDefaultJournalPath, setFileJournal } from './policy.js'
import { setEnvSigner, setKeyLoader } from './runtime.js'
import { loadKeypair, signerFromEnv } from './signer-node.js'

setFileJournal(fileJournal)
setDefaultJournalPath(defaultJournalFilePath)
setKeyLoader((source) => keypairSigner(loadKeypair(source)))
setEnvSigner(signerFromEnv)
