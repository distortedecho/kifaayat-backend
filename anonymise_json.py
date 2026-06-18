#!/usr/bin/env python3
"""
anonymise_json.py

Read a JSON file and replace the personal-data fields (the ones listed in
fields_MT.xlsx) with synthetic values, writing the result to a NEW file so
the original is left untouched.

The synthetic values are modelled on the example values you supplied:
- UUIDs become new random UUIDs
- emails become realistic fake emails
- names become plausible fake names
- Stripe IDs keep their prefix (ch_, pi_, po_, tr_, txn_, acct_, cus_) and
  their "_secret_" structure, but the random parts are regenerated
- phone numbers keep their Australian shape (04xxxxxxxx string, or 4xxxxxxxx int)
- addresses, suburbs, states, postcodes and coordinates become plausible AU values
- bios and message text are replaced with generic synthetic text

Consistency: the same original value always maps to the same synthetic value
within a run (so cross-references like a reused paymentIntentId stay linked).
Pass --seed for fully reproducible output.

Two flagged fields are intentionally left as-is:
  attributes.privateData and attributes.profile.privateData
Their example was an empty object "{}"; the real personal data inside them is
covered by the specific child fields (phonenumber, isopersonalised).

Usage:
    python anonymise_json.py data.json
    python anonymise_json.py data.json -o data_synthetic.json
    python anonymise_json.py data.json --seed 42
    python anonymise_json.py data.json --minify
"""

import argparse
import json
import os
import random
import string
import sys
import uuid
from collections import Counter

# --------------------------------------------------------------------------
# Field -> kind mapping (derived from fields_MT.xlsx)
# --------------------------------------------------------------------------

FIELDS = {
    "id": "uuid",
    "attributes.email": "email",
    "attributes.profile.avatar": "uuid",
    "attributes.profile.bio": "bio",
    "attributes.profile.displayName": "display_name",
    "attributes.profile.firstName": "first_name",
    "attributes.profile.lastName": "last_name",
    "attributes.stripeAccountId": "stripe",
    "attributes.stripeCustomerId": "stripe",
    "attributes.availabilityPlan.timezone": "timezone",
    "attributes.location.lat": "lat",
    "attributes.location.lng": "lng",
    "attributes.publicData.countrylist": "country_list",
    "attributes.publicData.location.address": "au_address",
    "attributes.profile.privateData.phonenumber": "phone_int",
    "attributes.messages[].content": "message",
    "attributes.publicData.building": "building",
    "attributes.profile.protectedData.phoneNumber": "phone_str",
    "attributes.transactionId": "uuid",
    "attributes.payIns[].stripeChargeId": "stripe",
    "attributes.payIns[].stripePaymentIntentId": "stripe",
    "attributes.payIns[].stripePayoutId": "stripe",
    "attributes.payIns[].stripeTransferId": "stripe",
    "attributes.payOuts[].stripeBalanceTxId": "stripe",
    "attributes.payOuts[].stripeChargeId": "stripe",
    "attributes.payOuts[].stripePaymentIntentId": "stripe",
    "attributes.payOuts[].stripePayoutId": "stripe",
    "attributes.payOuts[].stripeTransferId": "stripe",
    "attributes.protectedData.shippingDetails.address.city": "city",
    "attributes.protectedData.shippingDetails.address.country": "country_code",
    "attributes.protectedData.shippingDetails.address.line1": "street_line1",
    "attributes.protectedData.shippingDetails.address.line2": "line2",
    "attributes.protectedData.shippingDetails.address.postalCode": "postcode",
    "attributes.protectedData.shippingDetails.address.state": "state_full",
    "attributes.protectedData.shippingDetails.name": "full_name",
    "attributes.protectedData.shippingDetails.phoneNumber": "phone_str",
    "attributes.profile.privateData.isopersonalised": "isopersonalised",
    "attributes.customerProtectedData.stripePaymentIntents.default.stripePaymentIntentClientSecret": "stripe",
    "attributes.customerProtectedData.stripePaymentIntents.default.stripePaymentIntentId": "stripe",
}

# Flagged but intentionally left unchanged (empty-object containers).
SKIPPED_FIELDS = [
    "attributes.privateData",
    "attributes.profile.privateData",
]

# --------------------------------------------------------------------------
# Synthetic data pools
# --------------------------------------------------------------------------

FIRST_NAMES = [
    "Aanya", "Diya", "Isha", "Kavya", "Meera", "Neha", "Priya", "Riya",
    "Saanvi", "Tara", "Anika", "Pooja", "Sneha", "Aditi", "Nisha", "Sana",
    "Zara", "Aisha", "Sara", "Ananya", "Ishita", "Roshni", "Simran",
    "Aarav", "Arjun", "Dev", "Ishaan", "Kabir", "Rohan", "Veer", "Aryan",
    "Karan", "Rahul", "Vivaan", "Aman", "Dhruv", "Nikhil", "Sahil", "Yash",
]

LAST_NAMES = [
    "Sharma", "Patel", "Singh", "Kumar", "Gupta", "Mehta", "Shah", "Reddy",
    "Nair", "Iyer", "Das", "Bose", "Chopra", "Kapoor", "Malhotra", "Joshi",
    "Verma", "Rao", "Pillai", "Khan", "Ali", "Hussain", "Sheikh", "Desai",
    "Bhatt", "Menon", "Naidu", "Saxena", "Sethi", "Bajaj",
]

SUBURBS = [
    "Parramatta", "Blacktown", "Liverpool", "Castle Hill", "Bankstown",
    "Auburn", "Pendle Hill", "Pemulwuy", "Westmead", "Harris Park",
    "Granville", "Strathfield", "Hurstville", "Chatswood", "Ryde", "Penrith",
    "Campbelltown", "Toongabbie", "Seven Hills", "Merrylands",
    "Wentworthville", "Rooty Hill", "Glenwood", "Kellyville", "Quakers Hill",
]

STATES_FULL = [
    "New South Wales", "Victoria", "Queensland", "Western Australia",
    "South Australia", "Tasmania", "Australian Capital Territory",
    "Northern Territory",
]

STATE_ABBREV = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"]

STREET_NAMES = [
    "Wari", "Blue", "George", "Victoria", "Station", "Church", "Park",
    "High", "Railway", "Hill", "Forest", "Crown", "Marsden", "Pitt", "King",
    "Queen", "Smith", "Oxford", "William", "Kent",
]

STREET_TYPES = [
    "Street", "Road", "Avenue", "Place", "Crescent", "Drive", "Lane",
    "Court", "Parade", "Way",
]

EMAIL_DOMAINS = ["gmail.com", "hotmail.com", "outlook.com", "yahoo.com", "icloud.com"]

COUNTRY_LIST = ["australia", "new zealand", "united kingdom", "united states", "canada"]
COUNTRY_CODES = ["AU", "NZ", "GB", "US", "CA"]

TIMEZONES = [
    "Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane",
    "Australia/Perth", "Australia/Adelaide", "Pacific/Auckland",
]

BIO_TEMPLATES = [
    "Hi, I'm {first}! Lovely to meet you here. I sell my own and my family's "
    "pre-loved Desi outfits, and I also love buying pre-loved pieces for events. "
    "Based in {city}.",
    "Hello! I'm {first} from {city}. Decluttering my wardrobe of beautiful "
    "ethnic wear that deserves a new home. Happy to answer any questions.",
    "{first} here. Big fan of sustainable fashion and pre-loved South Asian "
    "clothing. Located in {city}, postage available Australia-wide.",
    "Welcome to my closet! I'm {first}, based in {city}. Selling lightly worn "
    "lehengas, sarees and party wear. Bundle deals available.",
]

MESSAGE_TEMPLATES = [
    "Hi, is this still available?",
    "Thank you, payment sent!",
    "Could you do a bundle deal on these two?",
    "Hi there, this item has already been sold.",
    "What are the measurements please?",
    "Can you post this to Melbourne?",
    "Lovely, I'll check and get back to you shortly.",
    "Hi, would you take a lower offer?",
    "Order received, will post tomorrow morning.",
    "Thanks so much, it arrived today and it's beautiful!",
    "Is the colour closer to red or maroon in person?",
    "Sorry for the delay, sending it out this week.",
]

# --------------------------------------------------------------------------
# Consistency cache: same original value -> same synthetic value
# --------------------------------------------------------------------------

_cache = {}


def consistent(kind, original, generator):
    """Return a cached synthetic value for (kind, original), generating once."""
    key = (kind, original)
    if key not in _cache:
        _cache[key] = generator()
    return _cache[key]


# --------------------------------------------------------------------------
# Generators
# --------------------------------------------------------------------------

def rand_digits(n):
    return "".join(random.choice(string.digits) for _ in range(n))


def rand_like(s):
    """Random string matching s position-by-position in character class."""
    out = []
    for ch in s:
        if ch.isdigit():
            out.append(random.choice(string.digits))
        elif ch.islower():
            out.append(random.choice(string.ascii_lowercase))
        elif ch.isupper():
            out.append(random.choice(string.ascii_uppercase))
        else:
            out.append(ch)
    return "".join(out)


def gen_uuid(original):
    return consistent("uuid", original, lambda: str(uuid.uuid4()))


def gen_email(original):
    def make():
        first = random.choice(FIRST_NAMES).lower()
        suffix = random.choice(["", str(random.randint(1, 99)), random.choice(LAST_NAMES).lower()])
        return f"{first}{suffix}@{random.choice(EMAIL_DOMAINS)}"
    return consistent("email", original, make)


def gen_first(original):
    return consistent("first_name", original, lambda: random.choice(FIRST_NAMES))


def gen_last(original):
    return consistent("last_name", original, lambda: random.choice(LAST_NAMES))


def gen_display(original):
    return consistent("display_name", original, lambda: random.choice(FIRST_NAMES))


def gen_full_name(original):
    return consistent(
        "full_name", original,
        lambda: f"{random.choice(FIRST_NAMES)} {random.choice(LAST_NAMES)}",
    )


def gen_stripe(original):
    """Keep alphabetic prefixes/keywords (ch, pi, acct, secret...), randomise the rest."""
    if original is None:
        return None
    if not isinstance(original, str):
        return original

    def make():
        parts = original.split("_")
        return "_".join(p if p.isalpha() else rand_like(p) for p in parts)
    return consistent("stripe", original, make)


def gen_phone_str(original):
    return consistent("phone_str", original, lambda: "04" + rand_digits(8))


def gen_phone_int(original):
    return consistent("phone_int", original, lambda: int("4" + rand_digits(8)))


def gen_timezone(original):
    return random.choice(TIMEZONES)


def gen_lat(original):
    # Greater-Sydney latitude band, ~6 dp like the example.
    return round(random.uniform(-34.10, -33.60), 6)


def gen_lng(original):
    # Greater-Sydney longitude band, ~5 dp like the example.
    return round(random.uniform(150.60, 151.30), 5)


def gen_country_list(original):
    return random.choice(COUNTRY_LIST)


def gen_country_code(original):
    return random.choice(COUNTRY_CODES)


def gen_au_address(original):
    return f"{random.choice(SUBURBS)} {random.choice(STATE_ABBREV)} {rand_digits(4)}, Australia"


def gen_building(original):
    return f"{random.choice(STREET_NAMES).lower()} {random.choice(STREET_TYPES).lower()} {random.choice(SUBURBS).lower()}"


def gen_city(original):
    return random.choice(SUBURBS)


def gen_state_full(original):
    return random.choice(STATES_FULL)


def gen_street_line1(original):
    return f"{random.randint(1, 250)} {random.choice(STREET_NAMES)} {random.choice(STREET_TYPES)}"


def gen_line2(original):
    return str(random.randint(1, 40))


def gen_postcode(original):
    return str(random.randint(2000, 7999))


def gen_bio(original):
    return random.choice(BIO_TEMPLATES).format(
        first=random.choice(FIRST_NAMES), city=random.choice(SUBURBS)
    )


def gen_message(original):
    return random.choice(MESSAGE_TEMPLATES)


def gen_isopersonalised(original):
    return "".join(random.choice(string.ascii_lowercase) for _ in range(random.randint(3, 6)))


GENERATORS = {
    "uuid": gen_uuid,
    "email": gen_email,
    "first_name": gen_first,
    "last_name": gen_last,
    "display_name": gen_display,
    "full_name": gen_full_name,
    "stripe": gen_stripe,
    "phone_str": gen_phone_str,
    "phone_int": gen_phone_int,
    "timezone": gen_timezone,
    "lat": gen_lat,
    "lng": gen_lng,
    "country_list": gen_country_list,
    "country_code": gen_country_code,
    "au_address": gen_au_address,
    "building": gen_building,
    "city": gen_city,
    "state_full": gen_state_full,
    "street_line1": gen_street_line1,
    "line2": gen_line2,
    "postcode": gen_postcode,
    "bio": gen_bio,
    "message": gen_message,
    "isopersonalised": gen_isopersonalised,
}


# --------------------------------------------------------------------------
# Path traversal and replacement
# --------------------------------------------------------------------------

def apply_at_path(obj, segments, generator, counter, field_name):
    """
    Walk `obj` following `segments` and replace the leaf with generator(old).
    A segment ending in "[]" means the value is a list; recurse into each item.
    Missing keys are skipped silently (records vary in shape).
    """
    seg = segments[0]
    rest = segments[1:]
    is_list = seg.endswith("[]")
    key = seg[:-2] if is_list else seg

    if not isinstance(obj, dict) or key not in obj:
        return

    if is_list:
        lst = obj[key]
        if not isinstance(lst, list):
            return
        for item in lst:
            if rest:
                apply_at_path(item, rest, generator, counter, field_name)
    elif rest:
        apply_at_path(obj[key], rest, generator, counter, field_name)
    else:
        obj[key] = generator(obj[key])
        counter[field_name] += 1


def iter_records(data):
    """Top-level list -> each item; dict with a 'data' list -> each item; else the dict itself."""
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("data"), list):
        return data["data"]
    return [data]


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Replace personal-data fields in a JSON file with synthetic values."
    )
    parser.add_argument("path", help="Path to the source JSON file")
    parser.add_argument(
        "-o", "--output", default=None,
        help="Output file path (default: <input>_synthetic.json)"
    )
    parser.add_argument(
        "--seed", type=int, default=None,
        help="Random seed for reproducible output"
    )
    parser.add_argument(
        "--minify", action="store_true",
        help="Write compact JSON instead of indented"
    )
    args = parser.parse_args()

    if args.seed is not None:
        random.seed(args.seed)

    if args.output:
        out_path = args.output
    else:
        base, ext = os.path.splitext(args.path)
        out_path = f"{base}_synthetic{ext or '.json'}"

    if os.path.abspath(out_path) == os.path.abspath(args.path):
        sys.exit("Error: output path must differ from the input path.")

    try:
        with open(args.path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        sys.exit(f"Error: file not found: {args.path}")
    except json.JSONDecodeError as e:
        sys.exit(f"Error: invalid JSON in {args.path}: {e}")

    # Precompute split segments for each field.
    compiled = [(field, kind, field.split(".")) for field, kind in FIELDS.items()]

    counter = Counter()
    records = iter_records(data)
    for record in records:
        for field, kind, segments in compiled:
            apply_at_path(record, segments, GENERATORS[kind], counter, field)

    try:
        with open(out_path, "w", encoding="utf-8") as f:
            if args.minify:
                json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
            else:
                json.dump(data, f, ensure_ascii=False, indent=2)
    except OSError as e:
        sys.exit(f"Error: could not write output to {out_path}: {e}")

    # Summary
    print(f"Read {len(records)} record(s) from {args.path}")
    print(f"Wrote synthetic copy to {out_path}\n")
    print("Replacements per field:")
    touched = 0
    for field in FIELDS:
        n = counter[field]
        touched += n
        flag = "" if n else "   (not present in data)"
        print(f"  {field:<70} {n}{flag}")
    print(f"\nTotal values replaced: {touched}")
    print(f"Left unchanged (empty-object containers): {', '.join(SKIPPED_FIELDS)}")


if __name__ == "__main__":
    main()
