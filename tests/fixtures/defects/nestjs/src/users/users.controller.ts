@ApiTags('users')
@Controller('users')
export class UsersController {
  @Post()
  create(@Body() body: Record<string, any>): unknown {
    return body;
  }
}
