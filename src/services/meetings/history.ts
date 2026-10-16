import type { Meeting } from '../../domain/models';

export interface MeetingHistoryStore {
  meetings(): Meeting[];
  get(table: 'meetings', id: string): Meeting | null;
}
export class MeetingHistoryReader {
  constructor(
    private store: MeetingHistoryStore,
    private current: Meeting
  ) {}

  private allowed(meeting: Meeting | null): meeting is Meeting {
    return (
      !!meeting &&
      meeting.projectId === this.current.projectId &&
      meeting.id !== this.current.id &&
      meeting.createdAt <= this.current.createdAt
    );
  }

  search(query = '', offset = 0, limit = 20) {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const meetings = this.store
      .meetings()
      .filter(
        (meeting) =>
          this.allowed(meeting) &&
          terms.every((term) =>
            `${meeting.title} ${meeting.notes}`.toLocaleLowerCase().includes(term)
          )
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      total: meetings.length,
      meetings: meetings.slice(offset, offset + limit).map((meeting) => ({
        meetingId: meeting.id,
        title: meeting.title,
        status: meeting.status,
        createdAt: meeting.createdAt,
        updatedAt: meeting.updatedAt,
        version: meeting.version,
        preview: meeting.notes.slice(0, 300),
        citation: `[會議:${meeting.id}:v${meeting.version}]`,
      })),
      nextOffset: offset + limit < meetings.length ? offset + limit : null,
    };
  }

  read(id: string, offset = 0, limit = 12000) {
    const meeting = this.store.get('meetings', id);
    if (!this.allowed(meeting)) throw new Error('找不到可參考的先前會議紀錄');
    return {
      meetingId: meeting.id,
      title: meeting.title,
      projectId: meeting.projectId,
      createdAt: meeting.createdAt,
      updatedAt: meeting.updatedAt,
      version: meeting.version,
      status: meeting.status,
      citation: `[會議:${meeting.id}:v${meeting.version}]`,
      notes: meeting.notes.slice(offset, offset + limit),
      totalCharacters: meeting.notes.length,
      offset,
      nextOffset: offset + limit < meeting.notes.length ? offset + limit : null,
    };
  }
}
