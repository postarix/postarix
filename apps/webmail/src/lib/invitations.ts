import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { calendarKeys } from './calendar';

/** A calendar message (invitation, reply or cancellation) in the person's mail. */
export interface Invitation {
  method: 'REQUEST' | 'REPLY' | 'CANCEL';
  uid: string;
  sequence: number;
  recurrenceId: string | null;
  title: string;
  location: string | null;
  start: string | null;
  end: string | null;
  allDay: boolean;
  repeats: boolean;
  organizer: { email: string; name: string | null } | null;
  attendees: { email: string; name: string | null; status: string }[];
  sender: string | null;
  attendee: string | null;
  myStatus: string | null;
  eventId: string | null;
  actionable: boolean;
  applied: boolean;
  outdated: boolean;
}

const invitationKey = (emailId: string) => ['invitation', emailId] as const;
const path = (emailId: string) => `/mail/messages/${encodeURIComponent(emailId)}/invitation`;

export function useInvitation(emailId: string, enabled: boolean) {
  return useQuery({
    queryKey: invitationKey(emailId),
    enabled,
    queryFn: () => api<Invitation>(path(emailId)),
    retry: false,
  });
}

export function useAnswerInvitation(emailId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (response: 'accepted' | 'tentative' | 'declined') =>
      api<Invitation>(`${path(emailId)}/respond`, { method: 'POST', body: { response } }),
    onSuccess: (data) => queryClient.setQueryData(invitationKey(emailId), data),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: calendarKeys.allEvents }),
  });
}

export function useApplyInvitation(emailId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<Invitation>(`${path(emailId)}/apply`, { method: 'POST' }),
    onSuccess: (data) => queryClient.setQueryData(invitationKey(emailId), data),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: calendarKeys.allEvents }),
  });
}
