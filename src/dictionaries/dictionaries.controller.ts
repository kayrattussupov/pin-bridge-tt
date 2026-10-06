import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AgencyAuthGuard } from '../auth/agency-auth.guard';
import { ApiError } from '../common/api-error';
import {
  CATEGORIES,
  CATEGORY_NAMES,
  Category,
  PAID_RULES,
  REGIONS,
  REGION_NAMES,
  Region,
} from './catalog';
import { DictionariesService } from './dictionaries.service';

/** Reference data agencies need to build listings, served from the local copy. */
@Controller('v1/dictionaries')
@UseGuards(AgencyAuthGuard)
export class DictionariesController {
  constructor(private readonly dictionaries: DictionariesService) {}

  @Get('categories')
  categories() {
    return {
      data: CATEGORY_NAMES.map((name) => ({
        name,
        title: CATEGORIES[name].title,
        pin_rubric: CATEGORIES[name].rubric,
        paid_placement: PAID_RULES[name],
      })),
    };
  }

  @Get('categories/:category/attributes')
  async attributes(@Param('category') category: string) {
    if (!(CATEGORY_NAMES as string[]).includes(category)) {
      throw ApiError.notFound('Category');
    }
    const form = await this.dictionaries.rubricForm(category as Category);
    return {
      data: form.fields.map((field) => ({
        slug: field.slug,
        title: field.title,
        required: field.required,
        type: field.kind,
        ...(field.variants.length ? { values: field.variants.map((v) => v.label) } : {}),
      })),
    };
  }

  @Get('regions')
  regions() {
    return {
      data: REGION_NAMES.map((name) => ({
        name,
        title: REGIONS[name].title,
        pin_id: REGIONS[name].id,
      })),
    };
  }

  @Get('regions/:region/districts')
  async districts(@Param('region') region: string) {
    if (!(REGION_NAMES as string[]).includes(region)) {
      throw ApiError.notFound('Region');
    }
    return { data: await this.dictionaries.districts(region as Region) };
  }
}
