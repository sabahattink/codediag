import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CreateUserDto } from "./dto/create-user.dto";
import { UsersService, type User } from "./users.service";

@ApiTags("users")
@UseGuards(JwtAuthGuard)
@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: "List users" })
  findAll(): User[] {
    return this.users.findAll();
  }

  @Post()
  @ApiOperation({ summary: "Create a user" })
  create(@Body() dto: CreateUserDto): User {
    return this.users.create(dto);
  }
}
