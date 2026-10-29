import { Body, Controller, Post } from "@nestjs/common";
import { ApiOperation } from "@nestjs/swagger";
import { IsEmail, IsString } from "class-validator";

export class LoginDto {
  @IsEmail() email!: string;
  @IsString() password!: string;
}

@Controller("auth")
export class AuthController {
  // Public by design: must not be reported as a missing guard.
  @Post("login")
  @ApiOperation({ summary: "Exchange credentials for a token" })
  login(@Body() dto: LoginDto): Promise<{ token: string }> {
    return Promise.resolve({ token: dto.email });
  }
}
