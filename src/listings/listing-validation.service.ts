import { Inject, Injectable } from '@nestjs/common';
import type { AgencyContext } from '../auth/agency-context';
import { ApiError } from '../common/api-error';
import { TokenBucket } from '../common/token-bucket';
import { RedisService } from '../queue/redis.service';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { ConnectionNotActiveError, ConnectionsService } from '../connections/connections.service';
import { DictionariesService } from '../dictionaries/dictionaries.service';
import { pinErrorToApiError } from '../pin/pin-api-error';
import { PinClient } from '../pin/pin.client';
import { isPinError } from '../pin/pin.errors';
import type { CreateItemPayload } from '../pin/pin.types';
import { ListingIssue, MappingResult, mapListing } from './listing-mapper';
import { listingSchema } from './listing.schema';

export interface ValidationReport {
  valid: boolean;
  errors: ListingIssue[];
  warnings: ListingIssue[];
  /** What would be sent to Pin (picture ids are added at publish time). */
  pin_payload?: CreateItemPayload;
  checked_by_pin: boolean;
}

@Injectable()
export class ListingValidationService {
  constructor(
    private readonly dictionaries: DictionariesService,
    private readonly connections: ConnectionsService,
    private readonly pin: PinClient,
    @Inject(ENV) private readonly env: Env,
    redis: RedisService,
  ) {
    this.bucket = new TokenBucket(redis);
  }

  private readonly bucket: TokenBucket;

  /** Schema + mapping against Pin's form. Returns the mapping for reuse by publishing. */
  async map(
    agency: AgencyContext,
    input: unknown,
    displayName: string,
  ): Promise<MappingResult & { listing?: ReturnType<typeof listingSchema.parse> }> {
    const parsed = listingSchema.safeParse(input ?? {});
    if (!parsed.success) {
      return {
        errors: parsed.error.issues.map((issue) => ({
          field: issue.path.join('.') || '(listing)',
          code: issue.code,
          message: issue.message,
        })),
        warnings: [],
        imageUrls: [],
      };
    }
    const listing = parsed.data;
    if (!this.env.UNSAFE_ALLOW_PRIVATE_OUTBOUND_HOSTS) {
      const insecure = listing.images
        .map((url, index) => ({ url, index }))
        .filter(({ url }) => !url.startsWith('https://'));
      if (insecure.length) {
        return {
          errors: insecure.map(({ index }) => ({
            field: `images.${index}`,
            code: 'https_required',
            message: 'Image URLs must use https.',
          })),
          warnings: [],
          imageUrls: [],
        };
      }
    }
    const [form, districts] = await Promise.all([
      this.dictionaries.rubricForm(listing.category),
      listing.district_ids?.length
        ? this.dictionaries.districts(listing.region).catch(() => undefined)
        : undefined,
    ]);
    return {
      ...mapListing(listing, { form, agencySlug: agency.agencySlug, displayName, districts }),
      listing,
    };
  }

  /**
   * Dry run for agencies. With a connection, the mapped payload is also checked by Pin's
   * validate_ad (pictures are not uploaded for this).
   */
  async validate(
    agency: AgencyContext,
    input: unknown,
    connectionId?: string,
  ): Promise<ValidationReport> {
    let displayName = agency.agencyName;
    if (connectionId) {
      const connection = await this.connections.get(agency, connectionId);
      displayName = connection.display_name;
    }
    const mapping = await this.map(agency, input, displayName);
    const report: ValidationReport = {
      valid: mapping.errors.length === 0,
      errors: mapping.errors,
      warnings: mapping.warnings,
      pin_payload: mapping.payload,
      checked_by_pin: false,
    };
    if (!report.valid || !connectionId || !mapping.payload) {
      return report;
    }

    let auth;
    try {
      auth = await this.connections.authFor(connectionId);
    } catch (error) {
      if (error instanceof ConnectionNotActiveError) {
        throw new ApiError(
          409,
          'connection_not_active',
          `The connection is ${error.status}; connect it first.`,
        );
      }
      throw error;
    }
    // Pin's budget is shared by every agency; one agency's dry runs must not use it all up.
    const wait = await this.bucket.take(
      `pin-bridge:agency-pin-budget:${agency.agencyId}`,
      this.env.AGENCY_PIN_RPS,
      Math.max(1, Math.ceil(this.env.AGENCY_PIN_RPS * 10)),
    );
    if (wait > 0) {
      throw ApiError.tooManyRequests(
        'rate_limited',
        'Too many Pin validations for this agency.',
        wait / 1000,
      );
    }
    try {
      await this.pin.validateAd(auth, mapping.payload);
    } catch (error) {
      if (isPinError(error) && error.kind === 'validation') {
        return {
          ...report,
          valid: false,
          checked_by_pin: true,
          errors: error.pinErrors.map((e) => ({
            field: e.field ? `pin.${e.field}` : 'pin',
            code: 'pin_rejected',
            message: e.message,
          })),
        };
      }
      if (isPinError(error) && (error.retryable || error.kind === 'unexpected_response')) {
        // Pin's own check is down (prod's validate_ad answers 500): our checks still stand.
        return {
          ...report,
          warnings: [
            ...report.warnings,
            {
              field: 'pin',
              code: 'pin_check_unavailable',
              message: 'Pin’s own check is unavailable; only Pin Bridge’s checks were run.',
            },
          ],
        };
      }
      if (isPinError(error) && error.kind === 'unauthorized') {
        await this.connections.markReauthRequired(connectionId, 'pin_unauthorized');
        throw new ApiError(
          409,
          'connection_not_active',
          'Pin logged this account out; connect it again.',
        );
      }
      throw isPinError(error) ? pinErrorToApiError(error) : error;
    }
    return { ...report, checked_by_pin: true };
  }
}
