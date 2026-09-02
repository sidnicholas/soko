import { Controller, Inject, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";
import { ZodBody } from "../common/zod-validation.pipe";
import { SignalSubmitSchema, type SignalSubmitBody } from "./signal.dto";
import { SignalsService } from "./signals.service";

@ApiTags("signals")
@Controller("signals")
export class SignalsController {
  constructor(@Inject(SignalsService) private readonly signals: SignalsService) {}

  @Post()
  @ApiOperation({ summary: "Submit a multi-channel opportunity signal (supply or demand)" })
  submit(@CurrentUser() user: Principal, @ZodBody(SignalSubmitSchema) body: SignalSubmitBody) {
    requirePermission(user, "signal:submit");
    return this.signals.submit(body);
  }
}
