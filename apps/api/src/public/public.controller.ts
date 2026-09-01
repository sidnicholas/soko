import { Inject } from "@nestjs/common";
import { Controller, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ZodBody } from "../common/zod-validation.pipe";
import { PublicRequestSchema, type PublicRequestBody } from "./public.dto";
import { PublicService } from "./public.service";

@ApiTags("public")
@Controller("public")
export class PublicController {
  constructor(@Inject(PublicService) private readonly publicIntake: PublicService) {}

  @Post("requests")
  @ApiOperation({ summary: "Public demand intake (unauthenticated marketplace request)" })
  createRequest(@ZodBody(PublicRequestSchema) body: PublicRequestBody) {
    return this.publicIntake.createRequest(body);
  }
}
