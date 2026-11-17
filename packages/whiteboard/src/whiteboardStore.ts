import type {
  WhiteboardDocument,
  WhiteboardPerson,
  WhiteboardEditingLease,
} from './types.ts';

export interface StoredWhiteboard {
  board: WhiteboardDocument;
  owner: string;
  expiresAt: number;
  receipts: string[];
  editing?: WhiteboardEditingLease[];
}

export interface WhiteboardStore {
  read(
    id: string
  ): Promise<{ value: StoredWhiteboard; version: string } | null>;
  write(
    id: string,
    value: StoredWhiteboard,
    version: string | null
  ): Promise<void>;
  collectExpired(now: number): Promise<void>;
  readPeople(id: string, now: number): Promise<WhiteboardPerson[]>;
  writePerson(id: string, person: WhiteboardPerson, now: number): Promise<void>;
}
