import {
  BadGatewayException,
  ConflictException,
  type HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MailEngineError } from '@postarix/mail-engine';

/** Translates mail engine failures into HTTP errors without leaking server details. */
export function engineErrorToHttp(error: unknown): HttpException | unknown {
  if (!(error instanceof MailEngineError)) return error;
  switch (error.code) {
    case 'already_exists':
      return new ConflictException('The mailbox already exists on the mail server');
    case 'not_found':
      return new NotFoundException('The mailbox does not exist on the mail server');
    case 'unavailable':
      return new ServiceUnavailableException('The mail server is unavailable; try again later');
    case 'rejected':
      return new BadGatewayException('The mail server rejected the operation');
  }
}
