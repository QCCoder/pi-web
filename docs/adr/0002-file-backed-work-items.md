# Keep Work Items in portable files

Requirements and Bugs must remain readable, reviewable, and recoverable without Pi Workspace, so their structured state, narrative, attachments, and milestone history are stored as files inside the Workspace. A database may project those files into searchable lists and UI state, but it is disposable and never becomes the authoritative write model; this trades some indexing complexity for portability, Git history, and freedom from a proprietary data store.
