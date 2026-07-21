import { randomUUID } from 'node:crypto'

export type IdPrefix = 'vault' | 'project' | 'chat' | 'msg' | 'mem' | 'extract'

export function createId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID()}`
}
