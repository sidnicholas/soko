import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser, type Principal } from "../common/current-user";

@ApiTags("health")
@Controller("health")
export class HealthController {
  @Get()
  @ApiOperation({ summary: "Liveness probe" })
  check() {
    return { status: "ok", ts: new Date().toISOString() };
  }
}

@ApiTags("auth")
@Controller("me")
export class MeController {
  @Get()
  @ApiOperation({ summary: "The authenticated caller's identity and application role (§22)" })
  me(@CurrentUser() user: Principal) {
    return { id: user.userId, role: user.role, email: user.email ?? null };
  }
}
