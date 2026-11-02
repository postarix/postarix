# Archiving and legal hold

Organizations that must keep their mail (regulation, litigation) can turn on
archiving and legal hold in the admin panel (**Mailboxes › Archiving and legal
hold**). Only the organization's owners can change them; every change is in
the audit log.

## Archiving

Choose a mailbox of the organization as the archive (create one for it, such
as `archive@example.com`). From then on Postfix puts a copy of every message
the organization's addresses receive or send (mailboxes and aliases, mail apps
and webmail alike) into it, as it passes through the server, before anyone can
delete it. Spam is copied too, marked as such.

The archive is an ordinary mailbox: read and search it with the webmail or any
mail app, and export it with any IMAP tool. Keep its password with whoever
answers for compliance, not with the people whose mail it holds. While
archiving is on, the archive mailbox cannot be deleted or disabled.

Mail already in mailboxes before archiving was turned on is not copied; import
it into the archive if needed (the archive's owner can use **Import mail** in
the webmail).

## Legal hold

Under legal hold, no mailbox of the organization can be deleted or disabled,
the archive cannot be changed, and the organization itself cannot be deleted,
until an owner lifts the hold. Combined with archiving, every message received
or sent since archiving began stays in the archive whatever people delete from
their own mailboxes.

## Limits

- The archive's owner can delete messages from it like from any mailbox:
  protect its password, and check the audit log and backups.
