import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string> }>();
    return typeof request.headers.authorization === "string";
  }
}
