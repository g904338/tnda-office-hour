import { store } from '../../app/store';

/** Text pasted somewhere else (the overview's quick box) waiting for the composer. */
export const pendingText = store<string | null>(null);
/** A day picked on the calendar, to start a post on. */
export const pendingDay = store<string | null>(null);
