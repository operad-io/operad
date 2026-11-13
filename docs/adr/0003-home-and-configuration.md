# ADR 0003: The Home Directory and Configuration Files

Status: accepted

## Background

The kernel is not about code repositories; the `dev` plugin is. Personal-assistant plugins need no repository at all.

## Decisions

### D1: The kernel is not bound to a repository

operad has one home directory (default `~/.operad`). The configuration, the storage and the scheduling loop live there. Commands work in any directory, and the kernel does not read git. The `dev` plugin is what binds to repositories: it registers them (`operad repo add`), and each repository keeps its own settings inside the repository.

### D2: Configuration files are JSON with a JSON Schema

Configuration files (the home's `config.json`, a repository's `.operad/dev.json`) are JSON, each with a JSON Schema, so an editor can complete and check them. Flows and plugins are TypeScript; nothing else is.
