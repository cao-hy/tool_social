import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthGuard } from '../../common/guards/auth.guard';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';
import type { AuthenticatedRequest } from '../../common/auth/auth.types';
import { requireUser } from '../../common/auth/request-auth';
import { getRequestId } from '../../common/request-context';
import { AuthService } from './auth.service';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from './auth.schemas';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('register')
  async register(
    @Body(zodPipe(registerSchema)) body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.auth.register(body as never, this.auditContext(request));
    reply.header('Set-Cookie', this.auth.buildCookieHeader(result.sessionCookie));
    return { user: result.user, workspaces: result.workspaces };
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body(zodPipe(loginSchema)) body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.auth.login(body as never, this.auditContext(request));
    reply.header('Set-Cookie', this.auth.buildCookieHeader(result.sessionCookie));
    return { user: result.user, workspaces: result.workspaces };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(
    @Headers('cookie') cookieHeader: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.auth.logout(this.auth.readSessionToken(cookieHeader), this.auditContext(request));
    reply.header('Set-Cookie', this.auth.buildClearCookieHeader());
    return { loggedOut: true };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@Req() request: FastifyRequest & AuthenticatedRequest) {
    return this.auth.me(requireUser(request).id);
  }

  @Post('forgot-password')
  @HttpCode(202)
  async forgotPassword(
    @Body(zodPipe(forgotPasswordSchema)) body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.auth.forgotPassword(body as never, this.auditContext(request));
  }

  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(
    @Body(zodPipe(resetPasswordSchema)) body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.auth.resetPassword(body as never, this.auditContext(request));
  }

  private auditContext(request: FastifyRequest) {
    return {
      actorIp: request.ip,
      actorUserAgent: request.headers['user-agent'],
      requestId: getRequestId(request),
    };
  }
}
