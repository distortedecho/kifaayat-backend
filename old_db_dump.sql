--
-- PostgreSQL database dump
--

\restrict B166JAeC4myxUhTufV4kB2gaaLraigAZqkf9hQvUOLMLz9XsHqv3WNXoP03yki0

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: profiles; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.profiles (id, clerk_id, display_name, avatar_url, location, currency, size_preferences, occasion_tags, profile_complete, created_at, updated_at, is_admin, stripe_account_id, stripe_onboarding_complete, onesignal_player_id, suspended_at, banned_at, suspension_reason, ban_reason, trust_tier, trust_tier_override, user_intents, wishlist_public, payout_method) FROM stdin;
5a8c6efd-fbef-4156-85f4-09ce157f3b92	user_3D1cRxJMZExV9Q0lW16QLbSs6dR	Aditya Rathi	https://img.clerk.com/eyJ0eXBlIjoiZGVmYXVsdCIsImlpZCI6Imluc18zQWhNbXN5a1F4aGx6QzJjMDNmeTYyNnlRRXEiLCJyaWQiOiJ1c2VyXzNEMWNSeEpNWkV4VjlRMGxXMTZRTGJTczZkUiIsImluaXRpYWxzIjoiQVIifQ	AU	AUD	{"clothing_size": "Free Size"}	{}	t	2026-04-29 08:56:55.991277+00	2026-05-12 08:15:10.329721+00	f	acct_1TRTw02WFqXV6AAX	f	\N	\N	\N	\N	\N	0	\N	{}	f	kifaayat_wallet
58b4d340-e364-4053-ae67-254fb4988586	admin_3bc28afc-06cb-4818-b77f-b0f9d7570f23	Kifaayat Admin	\N	\N	AUD	{}	{}	t	2026-03-16 10:03:15.412917+00	2026-03-16 10:03:15.412917+00	t	\N	f	\N	\N	\N	\N	\N	0	\N	{}	f	\N
4ba560b1-1e4a-4343-be20-e6fbc2a095ba	user_3AkhlNgUSQzGja6vJbl491D5dw9	himanshu sanwal	https://img.clerk.com/eyJ0eXBlIjoicHJveHkiLCJzcmMiOiJodHRwczovL2ltYWdlcy5jbGVyay5kZXYvb2F1dGhfZ29vZ2xlL2ltZ18zQWtobEx2c0dvbVVrelo4Z2V0SFo5bXRaSDAifQ	AU	AUD	{"clothing_size": "UK4 / US0 / AU4"}	{}	t	2026-03-10 20:06:23.62389+00	2026-04-12 20:08:47.743128+00	f	acct_1TLUJEFISMafywVL	f	\N	\N	\N	\N	\N	0	\N	{}	f	kifaayat_wallet
e2e39425-3b73-45f1-9121-931930a63fa6	user_3B1qxbSWWy8qsnRpnCP7r9ce28d	\N	\N	\N	AUD	{}	{}	f	2026-03-16 13:19:32.92168+00	2026-03-16 13:19:32.92168+00	f	\N	f	\N	\N	\N	\N	\N	0	\N	{}	f	\N
17e9238d-374e-4c91-a838-b8407a0c5a89	user_3B1FYraVXQa7dPtPA4VX11zyjfP	Kanak Designs	https://img.clerk.com/eyJ0eXBlIjoicHJveHkiLCJzcmMiOiJodHRwczovL2ltYWdlcy5jbGVyay5kZXYvb2F1dGhfZ29vZ2xlL2ltZ18zQjFGWW9LWU5ZN2hqT3luU0xpYnhjN2VoR3UifQ	AU	AUD	{"hip": "63", "bust": "36", "waist": "26", "clothing_size": "UK6 / US2 / AU6"}	{}	t	2026-03-16 08:12:01.221615+00	2026-04-28 11:05:40.633547+00	f	acct_1TDO9DFVcmGat53S	t	\N	2026-03-16 11:22:38.03+00	2026-03-16 11:22:48.59+00	test usej jidfnv	hihihwdecwec	0	\N	{buy}	t	\N
8b200565-6ca3-4814-8213-fe034d2f5b08	user_3DZoKzhak53yXsBav453fpdOYZs	Aditya	https://img.clerk.com/eyJ0eXBlIjoicHJveHkiLCJzcmMiOiJodHRwczovL2ltYWdlcy5jbGVyay5kZXYvb2F1dGhfZ29vZ2xlL2ltZ18zRFpvS3paTDUyRFVScWhlWTRDMTJveFBFZ04ifQ	AU	AUD	{"clothing_size": "UK4 / US0 / AU4"}	{}	t	2026-05-11 11:28:14.707898+00	2026-05-11 11:28:45.001158+00	f	\N	f	\N	\N	\N	\N	\N	0	\N	{buy,sell}	f	\N
d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3	user_3AlisxFTHMoytid7oO1tSl3g5hT	Himanshu Sanwal	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/avatars/d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3/2fc9c6fd-6989-4595-b8c8-ba148cde893d.jpeg	AU	AUD	{"hip": "2", "bust": "2", "waist": "2", "clothing_size": "S"}	{}	t	2026-03-11 08:40:00.498933+00	2026-04-10 08:07:32.856409+00	f	acct_1TE7N2FAXC9S7rYR	f	\N	\N	\N	\N	\N	0	\N	{}	f	\N
21d6b9d9-2707-4c4a-93e7-e4339a725688	user_3BwT0XsdzjMkc6xJEOI6UHX3EyK	Claudina	https://img.clerk.com/eyJ0eXBlIjoicHJveHkiLCJzcmMiOiJodHRwczovL2ltYWdlcy5jbGVyay5kZXYvb2F1dGhfZ29vZ2xlL2ltZ18zQndUMFk3OGZ5QmhrTWVBOFRleFVaZnd5Q2wifQ	AU	AUD	{"clothing_size": "L"}	{}	t	2026-04-05 14:21:50.95346+00	2026-04-12 08:47:13.10446+00	f	acct_1TIrs1FFKSckAxmV	f	\N	\N	\N	\N	\N	0	\N	{sell}	f	\N
c7b5b811-acbe-44a0-8bb4-51483c01f4b4	user_3DcA7sumN8RoN7OJukrpnQhoYoE	testingBolna	https://img.clerk.com/eyJ0eXBlIjoicHJveHkiLCJzcmMiOiJodHRwczovL2ltYWdlcy5jbGVyay5kZXYvb2F1dGhfZ29vZ2xlL2ltZ18zRGNBN3M5N0xLVGNwR2VzNEdxelU4SVdJRHQifQ	AU	AUD	{"hip": "38", "bust": "36", "waist": "30", "clothing_size": "UK18 / US14 / AU18"}	{}	t	2026-05-12 07:27:01.587981+00	2026-05-12 10:34:06.301656+00	f	acct_1TWB8R2Zj6KWLbbv	f	\N	\N	\N	\N	\N	0	\N	{sell}	f	kifaayat_wallet
da8ac193-69dc-4506-be9f-05e7ff94690f	user_3DrZs53m4au3KA091yQZyxFu5bl	Aditya Rathi	https://img.clerk.com/eyJ0eXBlIjoicHJveHkiLCJzcmMiOiJodHRwczovL2ltYWdlcy5jbGVyay5kZXYvb2F1dGhfZ29vZ2xlL2ltZ18zRHJaczVVT2psY3FES0Y5bzVKd1RUWXpiOTAifQ	AU	AUD	{"hip": "38", "bust": "36", "waist": "30", "clothing_size": "UK24 / US20 / AU24"}	{}	t	2026-05-17 18:25:54.366529+00	2026-05-17 18:26:08.878477+00	f	\N	f	\N	\N	\N	\N	\N	0	\N	{}	f	\N
d5f157e6-8f8b-4c6e-8b62-1e6d89ff51b1	user_3BepbjKufPAUhMgE4uRPMmHsMsI	Pallavi Pednekar	\N	AU	AUD	{"clothing_size": "L"}	{}	t	2026-03-30 08:31:04.694538+00	2026-04-28 11:07:02.993887+00	f	acct_1TGbleF4zYrURi8o	f	\N	\N	\N	\N	\N	0	\N	{}	f	kifaayat_wallet
\.


--
-- Data for Name: admin_settings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.admin_settings (id, commission_rate, updated_at, updated_by, tier_thresholds, tier_commission_rates, category_medians, boost_price_cents, boost_duration_days, notification_toggles, auto_approve_config) FROM stdin;
8adc579c-fb79-4f47-8b5b-2ec30a974c91	12.00	2026-03-10 10:08:49.528094+00	\N	{"1": {"min_days": 0, "min_sales": 1, "min_rating": 4.0, "require_stripe": true}, "2": {"min_days": 30, "min_sales": 5, "min_rating": 4.2, "require_stripe": true}, "3": {"min_days": 90, "min_sales": 15, "min_rating": 4.5, "require_stripe": true}}	{"0": 12, "1": 11, "2": 10, "3": 8}	{}	500	7	{}	{"1": {"enabled": false, "max_risk": 30}, "2": {"enabled": true, "max_risk": 40}, "3": {"enabled": true, "max_risk": 60}}
\.


--
-- Data for Name: boost_pricing_tiers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.boost_pricing_tiers (id, duration_days, price_cents, is_active, display_order, created_at) FROM stdin;
dc888e2b-6746-49f8-97f7-0c764d1be8e7	7	500	t	0	2026-03-20 10:13:06.022942+00
6e861aaa-f507-468b-84b3-cf36a126e549	14	800	t	1	2026-03-20 10:13:06.022942+00
\.


--
-- Data for Name: listings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.listings (id, seller_id, title, description, category, condition, measurements, occasion_tags, colors, price_amount, price_currency, original_price_amount, negotiable, status, shipping_info, created_at, updated_at, rejection_reason, fabric_types, work_types, items_included, designer_name, is_known_designer, designer_verification_url, country_of_origin, dry_cleaning_status, alteration_room, fit_tips, is_rentable, rental_daily_rate, rental_4to7_rate, rental_8to14_rate, rental_cleaning_fee, rental_security_deposit, shipping_cost_amount, free_shipping, video_url, video_storage_path, view_count, save_count, inquiry_count, sale_percentage, risk_score, risk_scored_at, pickup_available, international_shipping, estimated_size, size_type, curation_tags) FROM stdin;
068913fb-382a-4e6b-9a52-dd96aa94a66e	17e9238d-374e-4c91-a838-b8407a0c5a89	Test	Hi	Lehenga	New	{"bust": "26", "waist": "36", "length": "36"}	{Sangeet,Wedding}	{Red,Blue}	20000	AUD	2000	t	active	\N	2026-03-18 07:53:13.339488+00	2026-05-12 12:08:45.033682+00	\N	{}	{}	{}	\N	f	\N	\N	\N	\N	\N	f	\N	\N	\N	\N	\N	\N	f	\N	\N	23	0	0	\N	\N	\N	f	f	\N	\N	{}
0fc846bc-5141-4717-9b64-61bc65fcea9f	17e9238d-374e-4c91-a838-b8407a0c5a89	Lehengas	Test	Lehenga	New	{"bust": "26", "waist": "26", "length": "26"}	{Wedding}	{Red}	3000	AUD	10000	t	active	20	2026-03-16 13:28:03.680449+00	2026-05-12 12:08:46.722405+00	\N	{}	{}	{}	\N	f	\N	\N	\N	\N	\N	f	\N	\N	\N	\N	\N	\N	f	\N	\N	8	0	0	\N	\N	\N	f	f	\N	\N	{}
3671d8c4-feef-4dd7-90e4-a6ea4586e249	58b4d340-e364-4053-ae67-254fb4988586	test	Test	Lehenga	Like New	{}	{Mehendi,Sangeet}	{}	10000	AUD	20000	f	active	free	2026-03-16 10:08:45.289899+00	2026-03-24 13:17:30.849868+00	\N	{}	{}	{}	\N	f	\N	\N	\N	\N	\N	f	\N	\N	\N	\N	\N	\N	f	\N	\N	7	0	0	\N	\N	\N	f	f	\N	\N	{}
db874dbf-7781-4223-894c-474e875258ca	58b4d340-e364-4053-ae67-254fb4988586	Bridal Lehenga	\N	Lehenga	Like New	{}	{Wedding}	{}	80000	AUD	200000	t	active	50	2026-03-16 10:29:05.132582+00	2026-04-02 10:09:55.627589+00	\N	{}	{}	{}	\N	f	\N	\N	\N	\N	\N	f	\N	\N	\N	\N	\N	\N	f	\N	\N	5	0	0	\N	\N	\N	f	f	\N	\N	{}
a80f4f7b-c5cb-44bb-9271-14d2beca2964	58b4d340-e364-4053-ae67-254fb4988586	Orange Lehenga	Testing	Lehenga	Like New	{}	{Wedding}	{}	20000	AUD	50000	t	active	20	2026-03-16 10:26:09.370399+00	2026-04-02 10:18:29.175626+00	\N	{}	{}	{}	\N	f	\N	\N	\N	\N	\N	f	\N	\N	\N	\N	\N	\N	f	\N	\N	7	0	0	\N	\N	\N	f	f	\N	\N	{}
36567d10-5529-45d1-b179-96b827eb1e6a	d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3	Neeru's Onion Georgette Heavy Hand Embroidered Lehenga Set with Net Dupatta	Stunning Neeru's Onion Georgette Lehenga Set, perfect for weddings, sangeet, or festive occasions. The lehenga features intricate heavy hand embroidery throughout, creating a rich and luxurious texture. Paired with a matching net dupatta, also adorned with delicate embroidery and a border. The sleeveless blouse complements the set with similar detailing. The soft onion pink hue is elegant and versatile, making this set ideal for grand celebrations, offering a blend of traditional craftsmanship a	Lehenga	Like New	{"bust": "20", "waist": "20", "length": "20"}	{Wedding,Sangeet,Festive,Party,Formal}	{"onion pink",gold,Pink}	28000	AUD	27000	t	draft	\N	2026-03-24 13:09:47.597588+00	2026-04-10 08:09:04.960717+00	\N	{Georgette,Net}	{Thread,Stone}	{Dupatta}	Neeru's	f	\N	Australia 	recommended	\N	\N	f	\N	\N	\N	\N	\N	2000	f	\N	\N	4	0	0	\N	\N	\N	f	f	\N	\N	{}
1aad1760-6b2f-49c0-957a-bf56d76b76e9	17e9238d-374e-4c91-a838-b8407a0c5a89	Sherwani	\N	Menswear	New	{"chest": "36", "waist": "26", "length": "26", "sleeve_length": "30"}	{Wedding}	{Blue}	30000	AUD	60000	t	active	20	2026-03-16 13:15:01.534561+00	2026-05-03 11:51:32.58126+00	\N	{}	{}	{}	\N	f	\N	\N	\N	\N	\N	f	\N	\N	\N	\N	\N	\N	f	\N	\N	10	0	0	\N	\N	\N	f	f	\N	\N	{}
18dad102-7239-4226-a166-c676adeb3436	17e9238d-374e-4c91-a838-b8407a0c5a89	Lehenga	Lehenga	Menswear	New	{"chest": "30", "waist": "45", "length": "56", "sleeve_length": "66"}	{Mehendi}	{Blue}	0	AUD	\N	f	draft	\N	2026-03-31 08:52:17.726074+00	2026-04-08 13:04:36.180924+00	\N	{Other}	{Chikankari}	{Dupatta/Stole,Pajama/Churidar}	\N	f	\N	\N	required	\N	\N	f	\N	\N	\N	\N	\N	\N	f	\N	\N	4	0	0	\N	\N	\N	f	f	\N	\N	{}
02504370-5673-4695-b7e9-ad92ee4d0584	d5f157e6-8f8b-4c6e-8b62-1e6d89ff51b1	Elegant Dark Green Floral Lehenga Choli with Sequin & Thread Work - Perfect for Weddings & Festive Occasions	This elegant lehenga choli set features a rich dark green base adorned with vibrant pink and gold floral prints, enhanced with intricate sequin and delicate thread embroidery. The ensemble includes a matching blouse with a sweetheart neckline and a coordinating dupatta. Crafted from a flowy fabric, likely georgette or net, it offers both comfort and a graceful drape. Perfect for grand occasions such as weddings, sangeet, festive celebrations, or formal parties, offering a sophisticated and eye-c	Lehenga	Good	{"bust": "45", "waist": "36", "length": "65"}	{Wedding,Sangeet,Festive,Party,Formal}	{"dark green",pink,gold,maroon,Green}	35000	AUD	\N	t	draft	\N	2026-03-30 09:05:58.090648+00	2026-05-03 11:30:46.884052+00	\N	{Georgette,Net}	{Sequin,Thread}	{Blouse,Skirt,Dupatta}	Sabyasa	f	\N	\N	\N	\N	\N	f	\N	\N	\N	\N	\N	\N	t	\N	\N	2	0	0	\N	\N	\N	f	f	\N	\N	{}
1e2e9d60-64a6-462b-81f5-1a69d9f191b5	17e9238d-374e-4c91-a838-b8407a0c5a89	Dark Green Floral Georgette Lehenga Choli with Sequin & Thread Work - Perfect for Sangeet/Mehendi	Stunning dark green georgette lehenga choli set featuring intricate floral patterns in shades of pink, maroon, and gold. Embellished with delicate sequin and thread work, adding a subtle sparkle. The set includes a beautifully embroidered blouse, a voluminous skirt, and a matching dupatta. Ideal for festive occasions, sangeet, mehendi, or parties. Comfortable and elegant, this preloved outfit is in excellent condition, ready to make a statement.	Lehenga	Like New	{"bust": "34", "waist": "44", "length": "36"}	{Sangeet,Mehendi,Festive,Party}	{"dark green",pink,maroon,gold}	25000	AUD	\N	f	reserved	\N	2026-03-30 11:08:35.612081+00	2026-04-05 14:30:16.684622+00	\N	{Georgette}	{Sequin,Thread}	{Blouse,Skirt,Dupatta}	\N	f	\N	\N	required	\N	\N	f	\N	\N	\N	\N	\N	\N	f	\N	\N	4	0	0	\N	43	2026-03-30 11:09:02.107+00	f	f	\N	\N	{}
2e4d44db-73b9-4448-a912-79c991e8a524	5a8c6efd-fbef-4156-85f4-09ce157f3b92	Hand-Embroidered Floral Cushion Cover - Brown & White Home Decor	Beautiful pre-loved cushion cover featuring intricate hand-embroidered floral patterns in shades of brown, orange, red, and green on a white base. The reverse side and borders are a solid rich brown, likely a satin or silk blend, with a concealed zipper closure. Perfect for adding a touch of traditional elegance and color to your living room or bedroom decor. Excellent condition with vibrant embroidery.	Other	Pre-loved	{}	{}	{Brown,White,Multi}	0	AUD	\N	f	draft	\N	2026-04-29 08:59:59.600825+00	2026-04-29 08:59:59.600825+00	\N	{Cotton,Satin}	{Thread}	{}	\N	f	\N	\N	\N	\N	\N	f	\N	\N	\N	\N	\N	\N	f	\N	\N	0	0	0	\N	\N	\N	f	f	\N	\N	{}
5ee30352-5c13-49b8-99de-e44158bf0e60	17e9238d-374e-4c91-a838-b8407a0c5a89	Elegant Pink & Grey Sharara Suit with Gota Patti & Sequin Work - Perfect for Festive Occasions	This elegant Sharara suit features a beautiful blush pink kurta crafted from a silk blend fabric, adorned with delicate vertical gold thread and Gota Patti work. The contrasting light grey sharara pants are made from a flowy fabric, possibly georgette or crepe, with a matching embellished border. Completing the ensemble is a sheer light grey net dupatta, intricately detailed with scattered sequins and a rich Gota Patti border. Ideal for festive celebrations, parties, or sangeet events, offering	Sharara	Like New	{"hip": "45", "waist": "35", "length": "35"}	{Festive,Party,Sangeet}	{pink,grey,silver,gold}	18000	USD	36000	t	reserved	\N	2026-03-30 11:07:06.479053+00	2026-04-08 12:49:15.027337+00	\N	{Silk,Georgette,Net}	{"Gota Patti",Sequin,Thread}	{Top/Kurta,Sharara,Dupatta}	Anita	f	\N	\N	already_cleaned	\N	\N	f	\N	\N	\N	\N	\N	\N	f	\N	\N	7	0	0	\N	19	2026-03-30 11:07:37.888+00	f	f	\N	\N	{}
d2859a4b-a00d-48fa-9979-b355818f0548	17e9238d-374e-4c91-a838-b8407a0c5a89	Bridal lehenga	Lehenga beautiful	Lehenga	New	{"bust": "45", "waist": "55", "length": "65"}	{Sangeet,Wedding}	{Red,Blue}	20000	AUD	90000	t	active	\N	2026-03-24 10:13:38.896323+00	2026-05-03 11:41:44.12389+00	\N	{Georgette}	{Sequin,Chikankari}	{Dupatta,Cancan/Petticoat}	Sabya	f	\N	India	already_cleaned	\N	\N	f	\N	\N	\N	\N	\N	2000	f	\N	\N	2	0	0	\N	73	2026-03-24 10:14:02.899+00	f	f	\N	\N	{}
9d676637-27e6-43cb-b631-c2f14b23bcd5	17e9238d-374e-4c91-a838-b8407a0c5a89	Elegant Dark Green Floral Lehenga Choli Set with Sequin & Thread Embroidery - Perfect for Weddings & Festive Occasions	Stunning dark green georgette lehenga choli set featuring exquisite floral thread embroidery in shades of pink, maroon, and gold, enhanced with delicate sequin work. The full-flared lehenga skirt boasts a broad embellished waistband, complementing the intricately worked sweetheart neckline blouse. A matching dupatta with coordinating floral motifs completes this elegant ensemble. Ideal for Mehendi, Sangeet, festive events, or parties, offering a blend of traditional charm and contemporary style.	Lehenga	Like New	{"bust": "35", "waist": "35", "length": "25"}	{Wedding,Mehendi,Sangeet,Festive,Party}	{"dark green",pink,gold,maroon,Green}	35000	AUD	\N	t	reserved	\N	2026-03-24 13:17:04.541802+00	2026-04-12 20:05:00.266424+00	\N	{Georgette}	{Thread,Sequin,"Gota Patti"}	{Skirt,Blouse,Dupatta}	\N	f	\N	\N	required	\N	\N	f	\N	\N	\N	\N	\N	30000	f	\N	\N	11	0	0	\N	28	2026-03-24 13:17:48.603+00	f	f	\N	\N	{}
fa2a0fb6-7cf0-4efc-b073-3c1e6c945dcc	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	Dummy Lehemga	Lehenga	Lehenga	Pre-loved	{"bust": "40", "waist": "40", "length": "40"}	{}	{}	60000	AUD	90000	f	active	\N	2026-05-12 08:44:42.420196+00	2026-05-13 16:43:44.715375+00	\N	{Silk}	{}	{"Lehenga skirt"}	\N	f	\N	\N	\N	\N	\N	f	\N	\N	\N	\N	\N	\N	t	\N	\N	15	0	0	\N	\N	\N	f	f	Free Size	womens	{}
c975edd8-596d-4492-a096-56baff83fd5b	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	Testing rec	Test	Saree	New without tags	{"length": "40"}	{}	{}	50000	AUD	90000	f	draft	\N	2026-05-12 10:28:21.978051+00	2026-05-12 10:28:21.978051+00	\N	{Chiffon}	{}	{"Stitched Blouse"}	\N	f	\N	India	\N	\N	\N	f	\N	\N	\N	\N	\N	30000	f	\N	\N	0	0	0	\N	\N	\N	f	f	\N	\N	{}
935b993c-9a19-4e6f-811f-57a6b7819798	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	Dummy suit	This is a dummy-suit	Lehenga	New without tags	{"bust": "40", "waist": "40", "length": "40"}	{Casual,"Wedding party"}	{White,Orange,Pink}	50000	AUD	80000	f	sold	\N	2026-05-12 10:13:47.220438+00	2026-05-13 16:43:19.316995+00	\N	{Silk,Georgette,Net}	{Zardozi,Thread,Mirror}	{"Stitched Blouse","Lehenga skirt"}	Asim Jofa	t	\N	Other - Designer	\N	None\t	None	f	\N	\N	\N	\N	\N	\N	f	\N	\N	5	0	0	\N	\N	\N	f	f	Free Size	womens	{}
482f9f26-ba55-4415-a7a9-16b07e593193	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	Negotiable	Dummy	Kidswear	New without tags	{"chest": "40", "length": "40", "age_range": "3"}	{Festive}	{Navy}	8000	AUD	10000	f	sold	\N	2026-05-12 10:32:03.717719+00	2026-05-13 14:12:18.325213+00	\N	{Velvet}	{Plain}	{Top/Kurta}	\N	f	\N	India	\N	Yes\t	None	f	\N	\N	\N	\N	\N	\N	t	\N	\N	2	0	0	20	\N	\N	f	f	XL	menswear_kidswear	{}
72cc34a0-c072-4679-83d3-61ee3b9fa5aa	17e9238d-374e-4c91-a838-b8407a0c5a89	Elegant Dark Green Floral Lehenga Choli Set with Sequin & Thread Embroidery - Perfect for Weddings & Festive Occasions	Stunning dark green georgette lehenga choli set featuring exquisite floral thread embroidery in shades of pink, maroon, and gold, enhanced with delicate sequin work. The full-flared lehenga skirt boasts a broad embellished waistband, complementing the intricately worked sweetheart neckline blouse. A matching dupatta with coordinating floral motifs completes this elegant ensemble. Ideal for Mehendi, Sangeet, festive events, or parties, offering a blend of traditional charm and contemporary style.	Lehenga	Like New	{"bust": "35", "waist": "35", "length": "25"}	{Wedding,Mehendi,Sangeet,Festive,Party}	{"dark green",pink,gold,maroon,Green}	35000	AUD	\N	t	active	\N	2026-03-24 13:17:03.954822+00	2026-05-13 15:38:42.186579+00	\N	{Georgette}	{Thread,Sequin,"Gota Patti"}	{Skirt,Blouse,Dupatta}	\N	f	\N	\N	required	\N	\N	f	\N	\N	\N	\N	\N	30000	f	\N	\N	12	0	0	\N	25	2026-03-24 13:17:29.232+00	f	f	\N	\N	{}
\.


--
-- Data for Name: cart_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cart_items (id, user_id, listing_id, added_at) FROM stdin;
dbc1c636-2e0f-467a-b4dc-94d038bf6e55	d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3	3671d8c4-feef-4dd7-90e4-a6ea4586e249	2026-03-20 13:06:03.394517+00
856ab226-237e-425b-b394-2fc5fdd02f43	17e9238d-374e-4c91-a838-b8407a0c5a89	a80f4f7b-c5cb-44bb-9271-14d2beca2964	2026-03-20 13:16:22.445132+00
9e928c11-7ccc-493f-bef1-f2c195734023	17e9238d-374e-4c91-a838-b8407a0c5a89	db874dbf-7781-4223-894c-474e875258ca	2026-03-24 10:41:53.653334+00
36a3fd22-27f9-4580-98c1-b51407e25d1b	d5f157e6-8f8b-4c6e-8b62-1e6d89ff51b1	d2859a4b-a00d-48fa-9979-b355818f0548	2026-05-03 11:41:46.935752+00
5dfdbb5b-1de0-486f-b2af-3634740fa8d8	d5f157e6-8f8b-4c6e-8b62-1e6d89ff51b1	0fc846bc-5141-4717-9b64-61bc65fcea9f	2026-05-03 11:41:58.051448+00
\.


--
-- Data for Name: categories; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.categories (id, name, icon_url, display_order, is_active, created_at, updated_at) FROM stdin;
fba4c5bf-0170-4f12-b512-93da6d83cc5d	Lehenga	\N	0	t	2026-03-20 10:13:06.022942+00	2026-03-20 10:18:03.265+00
a0e4b1a3-cc02-4977-a5a6-b8f0ed4413b7	Saree	\N	1	t	2026-03-20 10:13:06.022942+00	2026-03-20 10:18:03.409+00
0150fae7-cbf9-44f7-9fa6-b18f21310451	Suit/Salwar	\N	2	t	2026-03-20 10:13:06.022942+00	2026-03-20 10:18:03.517+00
c528dad8-3109-41f0-8375-8d40e6c6866f	Anarkali	\N	3	t	2026-03-20 10:13:06.022942+00	2026-03-20 10:18:03.629+00
b29c4219-4541-4546-82ee-7c8deea8ccee	Indowestern	\N	4	t	2026-03-20 10:13:06.022942+00	2026-03-20 10:18:03.788+00
b67f8996-0c25-4030-9a45-c6f5dcc46b2f	Sharara	\N	5	t	2026-03-20 10:13:06.022942+00	2026-03-20 10:18:03.907+00
bfed6932-46a7-4264-aee5-4a9eb1aba184	Jewellery	\N	6	t	2026-03-20 10:13:06.022942+00	2026-03-20 10:18:04.022+00
936009d2-1db5-4158-8e41-fa960d6e01e8	Dupatta	\N	7	t	2026-03-20 10:13:06.022942+00	2026-03-20 10:18:04.132+00
2ffbd38f-458a-4d1b-8623-4b16902832ce	Blouse	\N	8	t	2026-03-20 10:13:06.022942+00	2026-03-20 10:18:04.313+00
05527026-8aa5-4a73-ba40-02b651774ae1	Menswear	\N	9	t	2026-03-20 10:13:06.022942+00	2026-03-20 10:18:04.424+00
2955bfa7-f682-43b4-9d9c-e75c9f5fe8b5	Kidswear	\N	10	t	2026-03-20 10:13:06.022942+00	2026-03-20 10:18:04.534+00
be35ff4b-1314-41ad-ba92-70fd6d12ff5e	Other	\N	11	t	2026-03-20 10:13:06.022942+00	2026-03-20 10:18:04.643+00
\.


--
-- Data for Name: conversations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.conversations (id, listing_id, buyer_id, seller_id, last_message_at, last_message_preview, created_at, updated_at) FROM stdin;
fdc9784a-04e1-48a2-b435-6c13d732d262	db874dbf-7781-4223-894c-474e875258ca	d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3	58b4d340-e364-4053-ae67-254fb4988586	2026-03-16 13:28:41.278+00	Is this available?	2026-03-16 13:28:34.894785+00	2026-03-16 13:28:41.39243+00
1f65c4b6-62ea-4671-a96a-711551261cac	068913fb-382a-4e6b-9a52-dd96aa94a66e	d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3	17e9238d-374e-4c91-a838-b8407a0c5a89	2026-03-20 13:05:35.913+00	Test	2026-03-20 10:37:35.82369+00	2026-03-20 13:05:35.987225+00
dbbc2bc0-24bf-4184-881e-a67f8d4451ed	3671d8c4-feef-4dd7-90e4-a6ea4586e249	d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3	58b4d340-e364-4053-ae67-254fb4988586	2026-03-24 04:32:37.99+00	Any flaws?	2026-03-24 04:32:36.818609+00	2026-03-24 04:32:38.037822+00
30a8f6b2-3688-4437-b83d-51130e819d39	3671d8c4-feef-4dd7-90e4-a6ea4586e249	17e9238d-374e-4c91-a838-b8407a0c5a89	58b4d340-e364-4053-ae67-254fb4988586	2026-03-24 10:30:36.769+00	Photo request: Close-up of fabric, Any damage/wear	2026-03-24 10:30:04.811289+00	2026-03-24 10:30:36.872233+00
ffbb0e20-2e2e-44f6-a378-1c354a2618ac	a80f4f7b-c5cb-44bb-9271-14d2beca2964	17e9238d-374e-4c91-a838-b8407a0c5a89	58b4d340-e364-4053-ae67-254fb4988586	2026-03-30 11:13:01.421+00	Hi there	2026-03-20 13:15:50.348347+00	2026-03-30 11:13:12.859725+00
e8660e35-851e-4a19-a2f9-5d38b3e0b78f	db874dbf-7781-4223-894c-474e875258ca	17e9238d-374e-4c91-a838-b8407a0c5a89	58b4d340-e364-4053-ae67-254fb4988586	2026-03-30 11:17:00.769+00	Alteration room?	2026-03-16 13:16:15.510782+00	2026-03-30 11:17:00.810141+00
3797982f-aada-4097-b78a-53a14a99c879	935b993c-9a19-4e6f-811f-57a6b7819798	5a8c6efd-fbef-4156-85f4-09ce157f3b92	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	2026-05-13 16:42:49.377+00	Yo	2026-05-13 16:23:32.323977+00	2026-05-13 16:42:49.509593+00
\.


--
-- Data for Name: desi_term_aliases; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.desi_term_aliases (id, alias, canonical) FROM stdin;
1	lehnga	lehenga
2	lehenga	lehenga
3	sarre	saree
4	sari	saree
5	saree	saree
6	salwar	suit/salwar
7	kameez	suit/salwar
8	churidar	suit/salwar
9	anarkali	anarkali
10	anarakali	anarkali
11	sharara	sharara
12	sharrara	sharara
13	gharara	sharara
14	sherwani	menswear
15	kurta	menswear
16	achkan	menswear
17	dupatta	dupatta
18	chunni	dupatta
19	jewellery	jewellery
20	jewelry	jewellery
21	jhumka	jewellery
22	jhumki	jewellery
23	blouse	blouse
24	choli	blouse
25	indowestern	indowestern
26	indo-western	indowestern
27	fusion	indowestern
\.


--
-- Data for Name: editorial_tags; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.editorial_tags (id, name, is_active, created_at) FROM stdin;
\.


--
-- Data for Name: exchange_rates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.exchange_rates (id, base_currency, target_currency, rate, fetched_at) FROM stdin;
1	AUD	USD	0.723000	2026-05-13 16:28:12.571+00
2	AUD	NZD	1.220000	2026-05-13 16:28:12.571+00
3	USD	AUD	1.380000	2026-05-13 16:28:12.571+00
4	USD	NZD	1.680000	2026-05-13 16:28:12.571+00
5	NZD	AUD	0.822000	2026-05-13 16:28:12.571+00
6	NZD	USD	0.595000	2026-05-13 16:28:12.571+00
\.


--
-- Data for Name: fraud_flags; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fraud_flags (id, entity_type, entity_id, flag_type, details, status, reviewed_by, created_at, reviewed_at) FROM stdin;
\.


--
-- Data for Name: iso_posts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.iso_posts (id, author_id, title, description, category, size, budget_min, budget_max, status, created_at, updated_at, market) FROM stdin;
\.


--
-- Data for Name: iso_comments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.iso_comments (id, iso_post_id, author_id, content, created_at) FROM stdin;
\.


--
-- Data for Name: iso_matches; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.iso_matches (id, iso_post_id, listing_id, match_score, match_reasons, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: iso_responses; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.iso_responses (id, iso_post_id, responder_id, listing_id, message, created_at, special_price) FROM stdin;
\.


--
-- Data for Name: listing_boosts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.listing_boosts (id, listing_id, seller_id, stripe_payment_intent_id, amount_paid, starts_at, ends_at, status, created_at) FROM stdin;
\.


--
-- Data for Name: listing_comments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.listing_comments (id, listing_id, author_id, content, created_at, updated_at) FROM stdin;
942edddc-3a94-4556-acb8-40beabe8b555	a80f4f7b-c5cb-44bb-9271-14d2beca2964	17e9238d-374e-4c91-a838-b8407a0c5a89	Hi, what size is this?	2026-04-02 10:13:16.145162+00	2026-04-02 10:13:16.145162+00
0411c9c1-05eb-4aca-a741-a3075b443128	5ee30352-5c13-49b8-99de-e44158bf0e60	21d6b9d9-2707-4c4a-93e7-e4339a725688	Interesting	2026-04-05 14:23:44.901733+00	2026-04-05 14:23:44.901733+00
3ab32eff-a3e3-4974-9073-8736b3ccadaf	9d676637-27e6-43cb-b631-c2f14b23bcd5	17e9238d-374e-4c91-a838-b8407a0c5a89	Interested	2026-04-10 14:16:39.118305+00	2026-04-10 14:16:39.118305+00
760dd557-c9ac-4735-81ce-1cba9867740c	fa2a0fb6-7cf0-4efc-b073-3c1e6c945dcc	5a8c6efd-fbef-4156-85f4-09ce157f3b92	Does it work?	2026-05-12 09:46:56.603795+00	2026-05-12 09:46:56.603795+00
1cc6c6e7-f02b-45d7-be6e-16573732f640	fa2a0fb6-7cf0-4efc-b073-3c1e6c945dcc	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	Can’t see you	2026-05-12 09:48:47.834442+00	2026-05-12 09:48:47.834442+00
22582ed5-6df8-4c39-b1ac-8faa4a57c34d	fa2a0fb6-7cf0-4efc-b073-3c1e6c945dcc	5a8c6efd-fbef-4156-85f4-09ce157f3b92	Here is my number 70118	2026-05-12 09:49:35.607253+00	2026-05-12 09:49:35.607253+00
cd5c7fc1-a657-4337-982a-a12d37699ba5	fa2a0fb6-7cf0-4efc-b073-3c1e6c945dcc	5a8c6efd-fbef-4156-85f4-09ce157f3b92	Hi	2026-05-13 14:38:04.056018+00	2026-05-13 14:38:04.056018+00
060d13bb-0eec-4aa8-9da2-31a7d737f2e4	fa2a0fb6-7cf0-4efc-b073-3c1e6c945dcc	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	Yo	2026-05-13 14:38:36.337441+00	2026-05-13 14:38:36.337441+00
fb89b2c6-b405-4f1e-a388-5a64e553685e	fa2a0fb6-7cf0-4efc-b073-3c1e6c945dcc	5a8c6efd-fbef-4156-85f4-09ce157f3b92	Hi	2026-05-13 14:42:12.404564+00	2026-05-13 14:42:12.404564+00
\.


--
-- Data for Name: listing_editorial_tags; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.listing_editorial_tags (listing_id, tag_id, assigned_at) FROM stdin;
\.


--
-- Data for Name: listing_photos; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.listing_photos (id, listing_id, storage_path, url, "position", created_at) FROM stdin;
4bb9a66b-40d6-490e-a48a-7e65a0b05eb5	3671d8c4-feef-4dd7-90e4-a6ea4586e249	listings/3671d8c4-feef-4dd7-90e4-a6ea4586e249/1773655728064_0.webp	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/listings/3671d8c4-feef-4dd7-90e4-a6ea4586e249/1773655728064_0.webp	0	2026-03-16 10:08:49.203308+00
3c6c752a-a0c0-4bf2-8a6c-511c62f81c34	3671d8c4-feef-4dd7-90e4-a6ea4586e249	listings/3671d8c4-feef-4dd7-90e4-a6ea4586e249/1773655730606_1.webp	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/listings/3671d8c4-feef-4dd7-90e4-a6ea4586e249/1773655730606_1.webp	1	2026-03-16 10:08:51.110331+00
8a9f1ebc-0018-44ca-957e-c1bf8dac7afd	3671d8c4-feef-4dd7-90e4-a6ea4586e249	listings/3671d8c4-feef-4dd7-90e4-a6ea4586e249/1773655732345_2.webp	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/listings/3671d8c4-feef-4dd7-90e4-a6ea4586e249/1773655732345_2.webp	2	2026-03-16 10:08:52.822943+00
a35696cf-d029-4e49-ae56-d7ef506be8c9	a80f4f7b-c5cb-44bb-9271-14d2beca2964	listings/a80f4f7b-c5cb-44bb-9271-14d2beca2964/1773656771127_0.jpg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/listings/a80f4f7b-c5cb-44bb-9271-14d2beca2964/1773656771127_0.jpg	0	2026-03-16 10:26:12.595351+00
afdfa154-c993-4437-8535-5b3863f5d563	db874dbf-7781-4223-894c-474e875258ca	listings/db874dbf-7781-4223-894c-474e875258ca/1773656947359_0.jpg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/listings/db874dbf-7781-4223-894c-474e875258ca/1773656947359_0.jpg	0	2026-03-16 10:29:09.209959+00
73c7e89c-608e-4c51-83fe-1ec3cbd8dd0f	db874dbf-7781-4223-894c-474e875258ca	listings/db874dbf-7781-4223-894c-474e875258ca/1773656950385_1.jpg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/listings/db874dbf-7781-4223-894c-474e875258ca/1773656950385_1.jpg	1	2026-03-16 10:29:12.107274+00
9ee0b9e9-6ccc-42d9-b3fe-088ab98e4da8	d2859a4b-a00d-48fa-9979-b355818f0548	17e9238d-374e-4c91-a838-b8407a0c5a89/d2859a4b-a00d-48fa-9979-b355818f0548/53112af3-b30c-461d-ba27-cd6012e63ace.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/d2859a4b-a00d-48fa-9979-b355818f0548/53112af3-b30c-461d-ba27-cd6012e63ace.jpeg	1	2026-03-24 10:13:44.134023+00
bf6219b9-8889-4afd-b92c-d4dea9da95a3	d2859a4b-a00d-48fa-9979-b355818f0548	17e9238d-374e-4c91-a838-b8407a0c5a89/d2859a4b-a00d-48fa-9979-b355818f0548/fe5d36fd-a27f-4a57-b98c-7bc31dd8bb05.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/d2859a4b-a00d-48fa-9979-b355818f0548/fe5d36fd-a27f-4a57-b98c-7bc31dd8bb05.jpeg	2	2026-03-24 10:13:46.061021+00
aa4eb87b-e786-4e59-a8fe-fc08f4a66907	d2859a4b-a00d-48fa-9979-b355818f0548	17e9238d-374e-4c91-a838-b8407a0c5a89/d2859a4b-a00d-48fa-9979-b355818f0548/219d67fd-14fe-4a5a-956e-7dc9bf7e20b4.png	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/d2859a4b-a00d-48fa-9979-b355818f0548/219d67fd-14fe-4a5a-956e-7dc9bf7e20b4.png	0	2026-03-24 10:13:42.131157+00
39f462df-7eb0-4b3b-b129-3067ec89056c	1aad1760-6b2f-49c0-957a-bf56d76b76e9	17e9238d-374e-4c91-a838-b8407a0c5a89/1aad1760-6b2f-49c0-957a-bf56d76b76e9/16aac420-dc91-4dfa-a27b-e4c16f466bc2.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/1aad1760-6b2f-49c0-957a-bf56d76b76e9/16aac420-dc91-4dfa-a27b-e4c16f466bc2.jpeg	2	2026-03-16 13:15:10.393662+00
0b9eed7f-ed12-4417-9383-3ad08dc0e272	1aad1760-6b2f-49c0-957a-bf56d76b76e9	17e9238d-374e-4c91-a838-b8407a0c5a89/1aad1760-6b2f-49c0-957a-bf56d76b76e9/7022ff20-e4f3-4916-b879-9efe77ba4e38.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/1aad1760-6b2f-49c0-957a-bf56d76b76e9/7022ff20-e4f3-4916-b879-9efe77ba4e38.jpeg	1	2026-03-16 13:15:07.769011+00
baf01d1c-89f9-4777-9d21-a6152b1cf04a	1aad1760-6b2f-49c0-957a-bf56d76b76e9	17e9238d-374e-4c91-a838-b8407a0c5a89/1aad1760-6b2f-49c0-957a-bf56d76b76e9/6360565b-458d-450c-93b8-c660a00c1ea4.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/1aad1760-6b2f-49c0-957a-bf56d76b76e9/6360565b-458d-450c-93b8-c660a00c1ea4.jpeg	0	2026-03-16 13:15:05.05436+00
3b64640c-23d8-43f8-a065-1f09a7d8c037	0fc846bc-5141-4717-9b64-61bc65fcea9f	17e9238d-374e-4c91-a838-b8407a0c5a89/0fc846bc-5141-4717-9b64-61bc65fcea9f/55264222-89be-4e6e-be1d-c7903f8c8d12.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/0fc846bc-5141-4717-9b64-61bc65fcea9f/55264222-89be-4e6e-be1d-c7903f8c8d12.jpeg	2	2026-03-16 13:28:24.686433+00
eb63dd91-1231-4998-82b4-75edc5c64ad2	0fc846bc-5141-4717-9b64-61bc65fcea9f	17e9238d-374e-4c91-a838-b8407a0c5a89/0fc846bc-5141-4717-9b64-61bc65fcea9f/df21b339-4d14-403b-bebd-2aaf9ca02db2.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/0fc846bc-5141-4717-9b64-61bc65fcea9f/df21b339-4d14-403b-bebd-2aaf9ca02db2.jpeg	0	2026-03-16 13:28:07.565857+00
0dbcea49-561f-4f3a-8a54-05c69d9ed0da	0fc846bc-5141-4717-9b64-61bc65fcea9f	17e9238d-374e-4c91-a838-b8407a0c5a89/0fc846bc-5141-4717-9b64-61bc65fcea9f/fc9ac96b-339d-469b-81f3-3c18d1f63bd7.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/0fc846bc-5141-4717-9b64-61bc65fcea9f/fc9ac96b-339d-469b-81f3-3c18d1f63bd7.jpeg	1	2026-03-16 13:28:11.571399+00
5c060213-982e-4f5c-83d3-040caadc0d85	068913fb-382a-4e6b-9a52-dd96aa94a66e	17e9238d-374e-4c91-a838-b8407a0c5a89/068913fb-382a-4e6b-9a52-dd96aa94a66e/c862ef74-fa1a-4193-878d-919711bfac10.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/068913fb-382a-4e6b-9a52-dd96aa94a66e/c862ef74-fa1a-4193-878d-919711bfac10.jpeg	1	2026-03-18 07:53:20.704903+00
4e1c777c-5a8a-4ac2-9070-7fa3459072ec	068913fb-382a-4e6b-9a52-dd96aa94a66e	17e9238d-374e-4c91-a838-b8407a0c5a89/068913fb-382a-4e6b-9a52-dd96aa94a66e/bf71c746-bd9b-4458-afc9-83c49bb104b4.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/068913fb-382a-4e6b-9a52-dd96aa94a66e/bf71c746-bd9b-4458-afc9-83c49bb104b4.jpeg	2	2026-03-18 07:53:23.135835+00
18ed18e2-410e-4c0d-b06b-f37eceabae48	068913fb-382a-4e6b-9a52-dd96aa94a66e	17e9238d-374e-4c91-a838-b8407a0c5a89/068913fb-382a-4e6b-9a52-dd96aa94a66e/14a64c84-d70c-4bdc-b340-bea0bd0f3609.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/068913fb-382a-4e6b-9a52-dd96aa94a66e/14a64c84-d70c-4bdc-b340-bea0bd0f3609.jpeg	0	2026-03-18 07:53:16.142181+00
b8d614b7-52e8-47d3-b385-7ba16626d5be	36567d10-5529-45d1-b179-96b827eb1e6a	d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3/36567d10-5529-45d1-b179-96b827eb1e6a/1d0ba485-f595-423d-b5b6-e3ab35e8e6db.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3/36567d10-5529-45d1-b179-96b827eb1e6a/1d0ba485-f595-423d-b5b6-e3ab35e8e6db.jpeg	2	2026-03-24 13:09:53.478135+00
b6688933-aaf6-4e11-b7a1-a4bffb5458f6	36567d10-5529-45d1-b179-96b827eb1e6a	d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3/36567d10-5529-45d1-b179-96b827eb1e6a/b7145e91-550d-4425-98c9-9836e86d3890.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3/36567d10-5529-45d1-b179-96b827eb1e6a/b7145e91-550d-4425-98c9-9836e86d3890.jpeg	0	2026-03-24 13:09:50.154685+00
28c08ba8-1c79-45dc-9736-66f3018e7fc3	36567d10-5529-45d1-b179-96b827eb1e6a	d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3/36567d10-5529-45d1-b179-96b827eb1e6a/d10d4330-689b-4d9f-848c-32f0981c5470.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3/36567d10-5529-45d1-b179-96b827eb1e6a/d10d4330-689b-4d9f-848c-32f0981c5470.jpeg	1	2026-03-24 13:09:51.770464+00
3f8eac9d-a50c-44d3-a7b1-06fd8e647943	72cc34a0-c072-4679-83d3-61ee3b9fa5aa	17e9238d-374e-4c91-a838-b8407a0c5a89/72cc34a0-c072-4679-83d3-61ee3b9fa5aa/5a8bdd40-d218-4b31-b383-bfc33e35876b.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/72cc34a0-c072-4679-83d3-61ee3b9fa5aa/5a8bdd40-d218-4b31-b383-bfc33e35876b.jpeg	1	2026-03-24 13:17:08.988931+00
d39cae1e-6778-4e3c-817f-826b47ecba65	72cc34a0-c072-4679-83d3-61ee3b9fa5aa	17e9238d-374e-4c91-a838-b8407a0c5a89/72cc34a0-c072-4679-83d3-61ee3b9fa5aa/5521712a-4603-432d-84eb-233fa6c06bed.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/72cc34a0-c072-4679-83d3-61ee3b9fa5aa/5521712a-4603-432d-84eb-233fa6c06bed.jpeg	2	2026-03-24 13:17:10.736976+00
16955c56-8f98-48ed-9e56-75eebc11d2df	72cc34a0-c072-4679-83d3-61ee3b9fa5aa	17e9238d-374e-4c91-a838-b8407a0c5a89/72cc34a0-c072-4679-83d3-61ee3b9fa5aa/de49ef4b-d576-4f4b-816c-a02005a15eed.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/72cc34a0-c072-4679-83d3-61ee3b9fa5aa/de49ef4b-d576-4f4b-816c-a02005a15eed.jpeg	0	2026-03-24 13:17:07.319813+00
d1143822-c9c7-4d6a-97f6-6ba6b7786484	9d676637-27e6-43cb-b631-c2f14b23bcd5	17e9238d-374e-4c91-a838-b8407a0c5a89/9d676637-27e6-43cb-b631-c2f14b23bcd5/98cac852-7ac7-4a35-994b-ad875f1e6dc1.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/9d676637-27e6-43cb-b631-c2f14b23bcd5/98cac852-7ac7-4a35-994b-ad875f1e6dc1.jpeg	1	2026-03-24 13:17:10.255913+00
524f9410-eb2f-47ad-aa23-4e5d8072e5f5	9d676637-27e6-43cb-b631-c2f14b23bcd5	17e9238d-374e-4c91-a838-b8407a0c5a89/9d676637-27e6-43cb-b631-c2f14b23bcd5/60da59f7-87b1-47af-8d9b-cd5cc78dfe48.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/9d676637-27e6-43cb-b631-c2f14b23bcd5/60da59f7-87b1-47af-8d9b-cd5cc78dfe48.jpeg	2	2026-03-24 13:17:12.682708+00
e009691d-41da-4e74-a427-fe26c81cd436	9d676637-27e6-43cb-b631-c2f14b23bcd5	17e9238d-374e-4c91-a838-b8407a0c5a89/9d676637-27e6-43cb-b631-c2f14b23bcd5/0520ad3d-4b4d-49c7-a931-ed7ad90b06a8.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/9d676637-27e6-43cb-b631-c2f14b23bcd5/0520ad3d-4b4d-49c7-a931-ed7ad90b06a8.jpeg	0	2026-03-24 13:17:07.98127+00
cc9cc002-45f3-479c-8d80-857aba74d7af	02504370-5673-4695-b7e9-ad92ee4d0584	d5f157e6-8f8b-4c6e-8b62-1e6d89ff51b1/02504370-5673-4695-b7e9-ad92ee4d0584/fe6d5d04-2126-417b-b07a-bfeff986c9e3.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/d5f157e6-8f8b-4c6e-8b62-1e6d89ff51b1/02504370-5673-4695-b7e9-ad92ee4d0584/fe6d5d04-2126-417b-b07a-bfeff986c9e3.jpeg	1	2026-03-30 09:06:03.680869+00
b11226f3-22e1-49d0-b3ad-901faa721b8e	02504370-5673-4695-b7e9-ad92ee4d0584	d5f157e6-8f8b-4c6e-8b62-1e6d89ff51b1/02504370-5673-4695-b7e9-ad92ee4d0584/5fd4c97d-c33b-4e07-8c20-2f48b6d39f25.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/d5f157e6-8f8b-4c6e-8b62-1e6d89ff51b1/02504370-5673-4695-b7e9-ad92ee4d0584/5fd4c97d-c33b-4e07-8c20-2f48b6d39f25.jpeg	2	2026-03-30 09:06:05.480308+00
397cd577-6ca2-4e60-a566-684344333bb2	02504370-5673-4695-b7e9-ad92ee4d0584	d5f157e6-8f8b-4c6e-8b62-1e6d89ff51b1/02504370-5673-4695-b7e9-ad92ee4d0584/4d52ac23-1b34-437a-be13-fde09a3edecc.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/d5f157e6-8f8b-4c6e-8b62-1e6d89ff51b1/02504370-5673-4695-b7e9-ad92ee4d0584/4d52ac23-1b34-437a-be13-fde09a3edecc.jpeg	0	2026-03-30 09:06:01.836694+00
17bc8238-1f2e-4e42-b2f7-e80521f2707f	5ee30352-5c13-49b8-99de-e44158bf0e60	17e9238d-374e-4c91-a838-b8407a0c5a89/5ee30352-5c13-49b8-99de-e44158bf0e60/3df11c4e-fbd1-4c49-850b-e06131145810.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/5ee30352-5c13-49b8-99de-e44158bf0e60/3df11c4e-fbd1-4c49-850b-e06131145810.jpeg	1	2026-03-30 11:07:11.842225+00
98ab154b-c28a-4462-9003-8dd597d9e35e	5ee30352-5c13-49b8-99de-e44158bf0e60	17e9238d-374e-4c91-a838-b8407a0c5a89/5ee30352-5c13-49b8-99de-e44158bf0e60/eb32a3dc-3199-4e30-a100-d125002a7cac.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/5ee30352-5c13-49b8-99de-e44158bf0e60/eb32a3dc-3199-4e30-a100-d125002a7cac.jpeg	2	2026-03-30 11:07:15.121983+00
df5e5799-bc3a-4d73-9964-eaa016785f6e	5ee30352-5c13-49b8-99de-e44158bf0e60	17e9238d-374e-4c91-a838-b8407a0c5a89/5ee30352-5c13-49b8-99de-e44158bf0e60/96514d8b-2a58-4fb6-8e7a-76e15caf7a76.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/5ee30352-5c13-49b8-99de-e44158bf0e60/96514d8b-2a58-4fb6-8e7a-76e15caf7a76.jpeg	0	2026-03-30 11:07:09.82186+00
2e744960-b9ba-447c-9b3a-4a53b5ae2135	1e2e9d60-64a6-462b-81f5-1a69d9f191b5	17e9238d-374e-4c91-a838-b8407a0c5a89/1e2e9d60-64a6-462b-81f5-1a69d9f191b5/d6d66a18-12e5-4444-9d4b-ec74412d2aa2.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/1e2e9d60-64a6-462b-81f5-1a69d9f191b5/d6d66a18-12e5-4444-9d4b-ec74412d2aa2.jpeg	1	2026-03-30 11:08:41.733325+00
74f1036e-b979-4bfe-856d-d4f29cc4aa9f	1e2e9d60-64a6-462b-81f5-1a69d9f191b5	17e9238d-374e-4c91-a838-b8407a0c5a89/1e2e9d60-64a6-462b-81f5-1a69d9f191b5/a2716981-85fd-41d4-9fe1-d815375eb342.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/1e2e9d60-64a6-462b-81f5-1a69d9f191b5/a2716981-85fd-41d4-9fe1-d815375eb342.jpeg	0	2026-03-30 11:08:39.17162+00
f19e02a2-466e-4d6c-8ffc-db469dbbcc50	1e2e9d60-64a6-462b-81f5-1a69d9f191b5	17e9238d-374e-4c91-a838-b8407a0c5a89/1e2e9d60-64a6-462b-81f5-1a69d9f191b5/1a72f8a5-2e97-4717-bf5a-bf75ef3f5166.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/1e2e9d60-64a6-462b-81f5-1a69d9f191b5/1a72f8a5-2e97-4717-bf5a-bf75ef3f5166.jpeg	2	2026-03-30 11:08:44.370111+00
7212d31f-b166-4092-9dfb-c46f82bb0e35	18dad102-7239-4226-a166-c676adeb3436	17e9238d-374e-4c91-a838-b8407a0c5a89/18dad102-7239-4226-a166-c676adeb3436/567109b6-113c-4fd6-803e-55efee765dec.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/18dad102-7239-4226-a166-c676adeb3436/567109b6-113c-4fd6-803e-55efee765dec.jpeg	2	2026-03-31 08:52:23.787088+00
40e9e08a-86d7-4b48-a08c-e44e3126f44e	18dad102-7239-4226-a166-c676adeb3436	17e9238d-374e-4c91-a838-b8407a0c5a89/18dad102-7239-4226-a166-c676adeb3436/ca3f05d8-001c-400d-9eac-6fb5a24ebba5.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/18dad102-7239-4226-a166-c676adeb3436/ca3f05d8-001c-400d-9eac-6fb5a24ebba5.jpeg	1	2026-03-31 08:52:21.869174+00
d0755840-9965-4dd8-a893-3322745e4702	18dad102-7239-4226-a166-c676adeb3436	17e9238d-374e-4c91-a838-b8407a0c5a89/18dad102-7239-4226-a166-c676adeb3436/52f973d1-1dd6-42e6-b0b2-fe2ec44352fb.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/17e9238d-374e-4c91-a838-b8407a0c5a89/18dad102-7239-4226-a166-c676adeb3436/52f973d1-1dd6-42e6-b0b2-fe2ec44352fb.jpeg	0	2026-03-31 08:52:20.033434+00
40b9772c-35c9-4ba0-a7cf-4266e39ea329	2e4d44db-73b9-4448-a912-79c991e8a524	5a8c6efd-fbef-4156-85f4-09ce157f3b92/2e4d44db-73b9-4448-a912-79c991e8a524/474a1ea6-650d-4c15-b149-4ecd46173be3.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/5a8c6efd-fbef-4156-85f4-09ce157f3b92/2e4d44db-73b9-4448-a912-79c991e8a524/474a1ea6-650d-4c15-b149-4ecd46173be3.jpeg	2	2026-04-29 09:00:19.560416+00
8778296a-eabf-4a6d-8f5f-129afd27362c	2e4d44db-73b9-4448-a912-79c991e8a524	5a8c6efd-fbef-4156-85f4-09ce157f3b92/2e4d44db-73b9-4448-a912-79c991e8a524/3b47090e-13b6-4a8b-909d-e6e649c478ce.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/5a8c6efd-fbef-4156-85f4-09ce157f3b92/2e4d44db-73b9-4448-a912-79c991e8a524/3b47090e-13b6-4a8b-909d-e6e649c478ce.jpeg	1	2026-04-29 09:00:12.250698+00
82ca23e3-20d2-4049-bf5b-0bd723d1a8c4	2e4d44db-73b9-4448-a912-79c991e8a524	5a8c6efd-fbef-4156-85f4-09ce157f3b92/2e4d44db-73b9-4448-a912-79c991e8a524/9af3bbc6-ed75-4fc0-a52e-c6ff8480a02f.jpeg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/5a8c6efd-fbef-4156-85f4-09ce157f3b92/2e4d44db-73b9-4448-a912-79c991e8a524/9af3bbc6-ed75-4fc0-a52e-c6ff8480a02f.jpeg	0	2026-04-29 09:00:06.840059+00
075d7e3c-3a65-4dbc-a40c-59aefc8718e7	fa2a0fb6-7cf0-4efc-b073-3c1e6c945dcc	c7b5b811-acbe-44a0-8bb4-51483c01f4b4/fa2a0fb6-7cf0-4efc-b073-3c1e6c945dcc/231f9d86-6e0e-42ba-8ee3-c4fa6d437153.jpg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/c7b5b811-acbe-44a0-8bb4-51483c01f4b4/fa2a0fb6-7cf0-4efc-b073-3c1e6c945dcc/231f9d86-6e0e-42ba-8ee3-c4fa6d437153.jpg	1	2026-05-12 08:44:44.895316+00
eccc569d-f206-49a5-b6bf-1d4270e5ef71	fa2a0fb6-7cf0-4efc-b073-3c1e6c945dcc	c7b5b811-acbe-44a0-8bb4-51483c01f4b4/fa2a0fb6-7cf0-4efc-b073-3c1e6c945dcc/a81c938d-98da-43a0-a47b-37ba88d6cb76.jpg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/c7b5b811-acbe-44a0-8bb4-51483c01f4b4/fa2a0fb6-7cf0-4efc-b073-3c1e6c945dcc/a81c938d-98da-43a0-a47b-37ba88d6cb76.jpg	2	2026-05-12 08:44:46.365508+00
dd96de21-a82f-4177-ab5c-509c1b612832	fa2a0fb6-7cf0-4efc-b073-3c1e6c945dcc	c7b5b811-acbe-44a0-8bb4-51483c01f4b4/fa2a0fb6-7cf0-4efc-b073-3c1e6c945dcc/6df9ffc9-337a-4505-a19e-71c8a80e34a7.heic	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/c7b5b811-acbe-44a0-8bb4-51483c01f4b4/fa2a0fb6-7cf0-4efc-b073-3c1e6c945dcc/6df9ffc9-337a-4505-a19e-71c8a80e34a7.heic	0	2026-05-12 08:44:43.728965+00
a8cd66de-687e-41a3-89b8-b379a69aa1f8	935b993c-9a19-4e6f-811f-57a6b7819798	c7b5b811-acbe-44a0-8bb4-51483c01f4b4/935b993c-9a19-4e6f-811f-57a6b7819798/e1400474-3462-48dd-88d9-8bd8b845a2aa.jpg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/c7b5b811-acbe-44a0-8bb4-51483c01f4b4/935b993c-9a19-4e6f-811f-57a6b7819798/e1400474-3462-48dd-88d9-8bd8b845a2aa.jpg	1	2026-05-12 10:13:50.714493+00
614f95af-88f5-4944-9c0b-5ae9e30964a0	935b993c-9a19-4e6f-811f-57a6b7819798	c7b5b811-acbe-44a0-8bb4-51483c01f4b4/935b993c-9a19-4e6f-811f-57a6b7819798/fa0d0b2a-b5bb-443c-b789-513363c1592b.jpg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/c7b5b811-acbe-44a0-8bb4-51483c01f4b4/935b993c-9a19-4e6f-811f-57a6b7819798/fa0d0b2a-b5bb-443c-b789-513363c1592b.jpg	2	2026-05-12 10:13:52.749825+00
c3e497bb-2996-476d-a20c-2af2c14cc8be	935b993c-9a19-4e6f-811f-57a6b7819798	c7b5b811-acbe-44a0-8bb4-51483c01f4b4/935b993c-9a19-4e6f-811f-57a6b7819798/76beb5d5-5bf1-405e-be5f-db87290f82a8.jpg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/c7b5b811-acbe-44a0-8bb4-51483c01f4b4/935b993c-9a19-4e6f-811f-57a6b7819798/76beb5d5-5bf1-405e-be5f-db87290f82a8.jpg	0	2026-05-12 10:13:48.803498+00
5d2e625a-2bc8-4c25-b2d6-75b9e8a753a2	c975edd8-596d-4492-a096-56baff83fd5b	c7b5b811-acbe-44a0-8bb4-51483c01f4b4/c975edd8-596d-4492-a096-56baff83fd5b/eda654d3-484e-4abf-9ebb-dedd07924fb2.jpg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/c7b5b811-acbe-44a0-8bb4-51483c01f4b4/c975edd8-596d-4492-a096-56baff83fd5b/eda654d3-484e-4abf-9ebb-dedd07924fb2.jpg	1	2026-05-12 10:28:24.810711+00
e6e83a57-d167-4181-8176-90156d7c4c5c	c975edd8-596d-4492-a096-56baff83fd5b	c7b5b811-acbe-44a0-8bb4-51483c01f4b4/c975edd8-596d-4492-a096-56baff83fd5b/7cb093fb-7787-496d-bced-0a58f2985791.jpg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/c7b5b811-acbe-44a0-8bb4-51483c01f4b4/c975edd8-596d-4492-a096-56baff83fd5b/7cb093fb-7787-496d-bced-0a58f2985791.jpg	2	2026-05-12 10:28:26.051224+00
0ad94e7a-e7a5-47ff-8ca4-aded1c5d747f	c975edd8-596d-4492-a096-56baff83fd5b	c7b5b811-acbe-44a0-8bb4-51483c01f4b4/c975edd8-596d-4492-a096-56baff83fd5b/19921729-91b7-40c1-86de-fb95861054a2.jpg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/c7b5b811-acbe-44a0-8bb4-51483c01f4b4/c975edd8-596d-4492-a096-56baff83fd5b/19921729-91b7-40c1-86de-fb95861054a2.jpg	0	2026-05-12 10:28:23.699884+00
cecec977-ff39-4813-9ab3-c3262f3a95c2	482f9f26-ba55-4415-a7a9-16b07e593193	c7b5b811-acbe-44a0-8bb4-51483c01f4b4/482f9f26-ba55-4415-a7a9-16b07e593193/089a26be-ce31-4ff7-a620-b29b26928079.jpg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/c7b5b811-acbe-44a0-8bb4-51483c01f4b4/482f9f26-ba55-4415-a7a9-16b07e593193/089a26be-ce31-4ff7-a620-b29b26928079.jpg	1	2026-05-12 10:32:06.864318+00
04c912d5-8e4e-4ae0-9246-3ad397447c99	482f9f26-ba55-4415-a7a9-16b07e593193	c7b5b811-acbe-44a0-8bb4-51483c01f4b4/482f9f26-ba55-4415-a7a9-16b07e593193/531c09b4-4124-4b04-a124-34661e3a3622.jpg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/c7b5b811-acbe-44a0-8bb4-51483c01f4b4/482f9f26-ba55-4415-a7a9-16b07e593193/531c09b4-4124-4b04-a124-34661e3a3622.jpg	2	2026-05-12 10:32:08.329024+00
28ccc8ce-9574-4998-8593-34c81146226e	482f9f26-ba55-4415-a7a9-16b07e593193	c7b5b811-acbe-44a0-8bb4-51483c01f4b4/482f9f26-ba55-4415-a7a9-16b07e593193/89bb27bf-f3ff-4492-b606-d219d1155b5f.jpg	https://ednvrsvaapdtdppalcrw.supabase.co/storage/v1/object/public/listing-photos/c7b5b811-acbe-44a0-8bb4-51483c01f4b4/482f9f26-ba55-4415-a7a9-16b07e593193/89bb27bf-f3ff-4492-b606-d219d1155b5f.jpg	0	2026-05-12 10:32:05.400336+00
\.


--
-- Data for Name: messages; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.messages (id, conversation_id, sender_id, content, read_at, created_at, message_type, image_url, metadata) FROM stdin;
22152dce-3c17-4c9b-90ee-e8e408bc9aa2	e8660e35-851e-4a19-a2f9-5d38b3e0b78f	17e9238d-374e-4c91-a838-b8407a0c5a89	Is this available?	\N	2026-03-16 13:16:18.494286+00	text	\N	{}
034059f6-dc31-4f04-afaa-07ce267362b9	e8660e35-851e-4a19-a2f9-5d38b3e0b78f	17e9238d-374e-4c91-a838-b8407a0c5a89	What's the lowest price?	\N	2026-03-16 13:16:20.055437+00	text	\N	{}
d7999e9d-9701-4265-b7fc-da7916a87399	e8660e35-851e-4a19-a2f9-5d38b3e0b78f	17e9238d-374e-4c91-a838-b8407a0c5a89	I	\N	2026-03-16 13:16:24.497689+00	text	\N	{}
644d2523-c77e-4c72-a853-c322f21c7853	fdc9784a-04e1-48a2-b435-6c13d732d262	d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3	Is this available?	\N	2026-03-16 13:28:39.195257+00	text	\N	{}
eb771967-30a5-4bd8-90ae-4d6ca11b0776	fdc9784a-04e1-48a2-b435-6c13d732d262	d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3	Is this available?	\N	2026-03-16 13:28:41.178359+00	text	\N	{}
fdb821ce-17ea-47f1-adb4-24c52955cfd8	e8660e35-851e-4a19-a2f9-5d38b3e0b78f	17e9238d-374e-4c91-a838-b8407a0c5a89	Hi	\N	2026-03-18 07:50:36.838476+00	text	\N	{}
29f088a5-5f77-40cd-bdd6-d4f649862add	1f65c4b6-62ea-4671-a96a-711551261cac	d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3	Any flaws?	2026-03-20 13:14:51.565+00	2026-03-20 10:37:36.301337+00	text	\N	{}
5b3eb1a0-8a15-4ac9-a9f5-1dde02f4788c	1f65c4b6-62ea-4671-a96a-711551261cac	d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3	Test	2026-03-20 13:14:51.565+00	2026-03-20 13:05:35.799137+00	text	\N	{}
4db0ac1d-5528-4d5e-b219-7a0b524e9b43	ffbb0e20-2e2e-44f6-a378-1c354a2618ac	17e9238d-374e-4c91-a838-b8407a0c5a89	Exact measurements?	\N	2026-03-20 13:15:51.62926+00	text	\N	{}
3020e667-ed51-40ac-9e64-6e3bbd5b8f77	ffbb0e20-2e2e-44f6-a378-1c354a2618ac	17e9238d-374e-4c91-a838-b8407a0c5a89	Photo request: Any damage/wear	\N	2026-03-20 13:16:02.621476+00	photo_request	\N	{"requested_photos": ["Any damage/wear"]}
719aadeb-ef16-46a6-88eb-4699fa9dc5db	ffbb0e20-2e2e-44f6-a378-1c354a2618ac	17e9238d-374e-4c91-a838-b8407a0c5a89	Alteration room?	\N	2026-03-20 13:16:12.7987+00	text	\N	{}
fc8128b8-735c-4441-b09d-33253fb88424	dbbc2bc0-24bf-4184-881e-a67f8d4451ed	d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3	Any flaws?	\N	2026-03-24 04:32:37.848878+00	text	\N	{}
9108f661-24e4-4215-ba2a-9db024c72ff6	30a8f6b2-3688-4437-b83d-51130e819d39	17e9238d-374e-4c91-a838-b8407a0c5a89	Exact measurements?	\N	2026-03-24 10:30:05.901451+00	text	\N	{}
b3c42e71-be38-48b2-a4e3-3f693d04ef35	30a8f6b2-3688-4437-b83d-51130e819d39	17e9238d-374e-4c91-a838-b8407a0c5a89	Photo request: Full outfit on hanger	\N	2026-03-24 10:30:19.518634+00	photo_request	\N	{"requested_photos": ["Full outfit on hanger"]}
47d75b43-fb51-47da-a476-26ae5da1023b	30a8f6b2-3688-4437-b83d-51130e819d39	17e9238d-374e-4c91-a838-b8407a0c5a89	Photo request: Close-up of fabric, Any damage/wear	\N	2026-03-24 10:30:36.672965+00	photo_request	\N	{"requested_photos": ["Close-up of fabric", "Any damage/wear"]}
395468f7-5603-4310-810b-5e3112d9cb74	ffbb0e20-2e2e-44f6-a378-1c354a2618ac	17e9238d-374e-4c91-a838-b8407a0c5a89	Hi there	\N	2026-03-30 11:13:01.267363+00	text	\N	{}
b87e8ed3-b5d0-4160-baa7-66882381db1b	e8660e35-851e-4a19-a2f9-5d38b3e0b78f	17e9238d-374e-4c91-a838-b8407a0c5a89	Exact measurements?	\N	2026-03-30 11:16:42.869801+00	text	\N	{}
f0edaa4d-cfd5-4dbd-b6f5-920adc3cb567	e8660e35-851e-4a19-a2f9-5d38b3e0b78f	17e9238d-374e-4c91-a838-b8407a0c5a89	Any flaws?	\N	2026-03-30 11:16:50.844795+00	text	\N	{}
c7dec084-be1e-4e8b-a201-50fa472be7a9	e8660e35-851e-4a19-a2f9-5d38b3e0b78f	17e9238d-374e-4c91-a838-b8407a0c5a89	Try-on photo?	\N	2026-03-30 11:16:55.783992+00	text	\N	{}
56f50f6c-2035-406b-b512-e8b697a3a50f	e8660e35-851e-4a19-a2f9-5d38b3e0b78f	17e9238d-374e-4c91-a838-b8407a0c5a89	Alteration room?	\N	2026-03-30 11:17:00.608855+00	text	\N	{}
2c5e14a3-024d-4767-afcf-7170b5c1b7c0	3797982f-aada-4097-b78a-53a14a99c879	5a8c6efd-fbef-4156-85f4-09ce157f3b92	Hi	2026-05-13 16:28:15.657+00	2026-05-13 16:25:49.906851+00	text	\N	{}
9e89c14b-5561-4671-91cb-9af1a2af80c5	3797982f-aada-4097-b78a-53a14a99c879	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	Wassup	2026-05-13 16:41:50.107+00	2026-05-13 16:41:26.033949+00	text	\N	{}
a209dfd3-7752-4a3e-870a-0aef9a0d1b56	3797982f-aada-4097-b78a-53a14a99c879	5a8c6efd-fbef-4156-85f4-09ce157f3b92	Yo	2026-05-13 16:42:58.164+00	2026-05-13 16:42:49.398089+00	text	\N	{}
\.


--
-- Data for Name: notification_preferences; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.notification_preferences (id, user_id, category, push_enabled, email_enabled, created_at, updated_at) FROM stdin;
fd2af18f-85a7-4ca6-aba9-1ae2789aae94	17e9238d-374e-4c91-a838-b8407a0c5a89	marketing	t	t	2026-03-24 13:17:57.565254+00	2026-03-24 13:17:57.494+00
8983b90e-40ac-4ff7-b346-37c17ecfdb97	21d6b9d9-2707-4c4a-93e7-e4339a725688	marketing	t	t	2026-04-05 14:41:42.938588+00	2026-04-05 14:41:42.823+00
\.


--
-- Data for Name: notification_type_config; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.notification_type_config (id, category, type_key, label, push_enabled, email_enabled, updated_at) FROM stdin;
d276d546-36c1-499d-8870-3b2e2daa1700	transaction	order_paid	Order Paid	t	t	2026-03-20 10:13:06.022942+00
3fb11263-27e4-4d11-9cae-44aed8cb2692	transaction	order_shipped	Order Shipped	t	t	2026-03-20 10:13:06.022942+00
05f8660c-97ad-4bcf-b291-c6f2ee91e088	transaction	order_delivered	Order Delivered	t	t	2026-03-20 10:13:06.022942+00
487fb394-ee5f-4078-9cad-61c6af462346	transaction	order_complete	Order Complete	t	t	2026-03-20 10:13:06.022942+00
fde8f749-3502-45a3-9368-e71d99817bec	transaction	offer_received	Offer Received	t	t	2026-03-20 10:13:06.022942+00
bedf53ae-1d75-43e7-88f2-1ad6c83801fe	transaction	offer_accepted	Offer Accepted	t	t	2026-03-20 10:13:06.022942+00
6396dafd-5a1a-431a-a514-3d546da42468	engagement	review_received	Review Received	t	t	2026-03-20 10:13:06.022942+00
e56bec75-691a-4d08-b8f1-1a74fc114eb3	engagement	wishlist_price_drop	Wishlist Price Drop	t	t	2026-03-20 10:13:06.022942+00
7410bbfe-196c-45bd-9098-d57e62621dcb	seller_updates	listing_approved	Listing Approved	t	t	2026-03-20 10:13:06.022942+00
c9043316-20ac-41f3-8d72-622f3c960e4f	seller_updates	listing_rejected	Listing Rejected	t	t	2026-03-20 10:13:06.022942+00
800d237f-b3c1-41a7-a8a1-0b207103ade3	seller_updates	tier_change	Tier Change	t	t	2026-03-20 10:13:06.022942+00
938f3835-39e8-4948-9a57-859507f2dd3b	marketing	weekly_digest	Weekly Digest	f	t	2026-03-20 10:13:06.022942+00
63605f54-7bb8-4b75-8cf3-3edd94315492	marketing	promotion	Promotion	f	t	2026-03-20 10:13:06.022942+00
\.


--
-- Data for Name: notifications; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.notifications (id, user_id, type, title, body, data, read, created_at) FROM stdin;
29d06b2b-a8cb-4c73-afad-c40d5c7add2a	58b4d340-e364-4053-ae67-254fb4988586	offer_received	New Offer Received	Kanak Designs offered A$200.00 for "Bridal Lehenga"	{"offer_id": "d7a140cb-a260-4c4f-a546-90c3273adad6", "listing_id": "db874dbf-7781-4223-894c-474e875258ca"}	f	2026-03-16 13:16:10.970296+00
0ed1f22a-73eb-49e4-98e4-5485d50c8f3f	58b4d340-e364-4053-ae67-254fb4988586	offer_received	New Offer Received	Kanak Designs offered A$20.00 for "Orange Lehenga"	{"offer_id": "3df93efa-7c2f-4ecd-a3e3-87b59539a311", "listing_id": "a80f4f7b-c5cb-44bb-9271-14d2beca2964"}	f	2026-03-18 07:50:56.771651+00
3118d1ce-cd39-4376-9b42-62631265031e	58b4d340-e364-4053-ae67-254fb4988586	new_message	New message from Kanak Designs	Exact measurements?	{"listing_id": "a80f4f7b-c5cb-44bb-9271-14d2beca2964", "conversation_id": "ffbb0e20-2e2e-44f6-a378-1c354a2618ac"}	f	2026-03-20 13:15:52.726629+00
6282174c-006a-4090-8cb4-6fbab7160b8b	17e9238d-374e-4c91-a838-b8407a0c5a89	new_message	New message from Himanshu Sanwal	Test	{"listing_id": "068913fb-382a-4e6b-9a52-dd96aa94a66e", "conversation_id": "1f65c4b6-62ea-4671-a96a-711551261cac"}	t	2026-03-20 13:05:36.839853+00
bef8100e-5303-4e1e-ae7b-0c50d67587f7	58b4d340-e364-4053-ae67-254fb4988586	new_message	New message from Himanshu Sanwal	Any flaws?	{"listing_id": "3671d8c4-feef-4dd7-90e4-a6ea4586e249", "conversation_id": "dbbc2bc0-24bf-4184-881e-a67f8d4451ed"}	f	2026-03-24 04:32:38.807815+00
b8b9370d-1c97-403a-b11c-7638c5ffb409	58b4d340-e364-4053-ae67-254fb4988586	new_message	New message from Kanak Designs	Exact measurements?	{"listing_id": "3671d8c4-feef-4dd7-90e4-a6ea4586e249", "conversation_id": "30a8f6b2-3688-4437-b83d-51130e819d39"}	f	2026-03-24 10:30:07.014929+00
9c5f47a2-97b9-468a-b019-81df9ecb1cd2	17e9238d-374e-4c91-a838-b8407a0c5a89	new_message	New message from Himanshu Sanwal	Any flaws?	{"listing_id": "068913fb-382a-4e6b-9a52-dd96aa94a66e", "conversation_id": "1f65c4b6-62ea-4671-a96a-711551261cac"}	t	2026-03-20 10:37:36.983814+00
0f4d9d42-dd63-4ad3-b9eb-230f62cb827b	58b4d340-e364-4053-ae67-254fb4988586	new_message	New message from Kanak Designs	Hi there	{"listing_id": "a80f4f7b-c5cb-44bb-9271-14d2beca2964", "conversation_id": "ffbb0e20-2e2e-44f6-a378-1c354a2618ac"}	f	2026-03-30 11:13:02.367516+00
f614d97b-3fce-4cea-8a2d-e144cb93a777	58b4d340-e364-4053-ae67-254fb4988586	new_message	New message from Kanak Designs	Exact measurements?	{"listing_id": "db874dbf-7781-4223-894c-474e875258ca", "conversation_id": "e8660e35-851e-4a19-a2f9-5d38b3e0b78f"}	f	2026-03-30 11:16:43.864346+00
443f1c1c-4b49-43b9-990f-af1162b26fdc	17e9238d-374e-4c91-a838-b8407a0c5a89	listing_approved	Listing Approved!	Your listing "Bridal lehenga" has been approved and is now live.	{"listing_id": "d2859a4b-a00d-48fa-9979-b355818f0548"}	f	2026-04-02 08:24:47.989156+00
bda2cf7a-3368-4261-95bb-a37532bf2f19	17e9238d-374e-4c91-a838-b8407a0c5a89	listing_approved	Listing Approved!	Your listing "Dark Green Floral Georgette Lehenga Choli with Sequin & Thread Work - Perfect for Sangeet/Mehendi" has been approved and is now live.	{"listing_id": "1e2e9d60-64a6-462b-81f5-1a69d9f191b5"}	f	2026-04-02 08:24:48.805328+00
f7dbfaee-921b-4c36-b957-5edd5329b57e	17e9238d-374e-4c91-a838-b8407a0c5a89	listing_approved	Listing Approved!	Your listing "Elegant Dark Green Floral Lehenga Choli Set with Sequin & Thread Embroidery - Perfect for Weddings & Festive Occasions" has been approved and is now live.	{"listing_id": "9d676637-27e6-43cb-b631-c2f14b23bcd5"}	f	2026-04-02 09:40:11.888555+00
d0d7a6d2-6628-42ee-83fc-218a9fe63851	17e9238d-374e-4c91-a838-b8407a0c5a89	listing_approved	Listing Approved!	Your listing "Elegant Dark Green Floral Lehenga Choli Set with Sequin & Thread Embroidery - Perfect for Weddings & Festive Occasions" has been approved and is now live.	{"listing_id": "72cc34a0-c072-4679-83d3-61ee3b9fa5aa"}	f	2026-04-02 09:40:16.246972+00
d986ca0a-96b0-4ea6-a573-582b44a7387e	17e9238d-374e-4c91-a838-b8407a0c5a89	listing_approved	Listing Approved!	Your listing "Elegant Pink & Grey Sharara Suit with Gota Patti & Sequin Work - Perfect for Festive Occasions" has been approved and is now live.	{"listing_id": "5ee30352-5c13-49b8-99de-e44158bf0e60"}	f	2026-04-02 09:40:20.095182+00
d21c9e02-e087-45a1-8905-070cb76e0d8f	58b4d340-e364-4053-ae67-254fb4988586	listing_comment	New comment on your listing	Kanak Designs commented on "Orange Lehenga"	{"comment_id": "942edddc-3a94-4556-acb8-40beabe8b555", "listing_id": "a80f4f7b-c5cb-44bb-9271-14d2beca2964"}	f	2026-04-02 10:13:16.597771+00
e0b925d7-6f53-4921-9295-e84c2aeab32a	17e9238d-374e-4c91-a838-b8407a0c5a89	listing_comment	New comment on your listing	Claudina commented on "Elegant Pink & Grey Sharara Suit with Gota Patti & Sequin Work - Perfect for Festive Occasions"	{"comment_id": "0411c9c1-05eb-4aca-a741-a3075b443128", "listing_id": "5ee30352-5c13-49b8-99de-e44158bf0e60"}	f	2026-04-05 14:23:45.327479+00
5e39fb0d-6477-43f2-81ec-0fe5ee8638fa	17e9238d-374e-4c91-a838-b8407a0c5a89	offer_received	New Offer Received	Claudina offered US$150.00 for "Elegant Pink & Grey Sharara Suit with Gota Patti & Sequin Work - Perfect for Festive Occasions"	{"offer_id": "a6a913a7-710d-4f5c-97bd-4a3dd661f977", "listing_id": "5ee30352-5c13-49b8-99de-e44158bf0e60"}	f	2026-04-05 14:24:27.012927+00
3be40cff-5260-450a-9b24-2262455bd702	21d6b9d9-2707-4c4a-93e7-e4339a725688	offer_countered	Counter-Offer Received	Kanak Designs countered with US$160.00 for "Elegant Pink & Grey Sharara Suit with Gota Patti & Sequin Work - Perfect for Festive Occasions" (Round 2 of 3)	{"offer_id": "ba28ab96-7c8c-45cd-ac58-d30ceb707d30", "listing_id": "5ee30352-5c13-49b8-99de-e44158bf0e60"}	f	2026-04-05 14:26:19.627431+00
3242ca26-446f-4997-bb94-840b4805268a	17e9238d-374e-4c91-a838-b8407a0c5a89	offer_accepted	Offer Accepted!	Your offer of US$160.00 for "Elegant Pink & Grey Sharara Suit with Gota Patti & Sequin Work - Perfect for Festive Occasions" was accepted. You have 24 hours to complete payment.	{"offer_id": "ba28ab96-7c8c-45cd-ac58-d30ceb707d30", "listing_id": "5ee30352-5c13-49b8-99de-e44158bf0e60"}	f	2026-04-08 12:49:15.442933+00
4b312975-d820-40a8-8a81-00c245c82152	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	listing_comment	New comment on your listing	Aditya Rathi commented on "Dummy Lehemga"	{"comment_id": "760dd557-c9ac-4735-81ce-1cba9867740c", "listing_id": "fa2a0fb6-7cf0-4efc-b073-3c1e6c945dcc"}	t	2026-05-12 09:46:56.868443+00
f6488b40-33d0-4163-95e5-3f022e08f581	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	listing_comment	New comment on your listing	Aditya Rathi commented on "Dummy Lehemga"	{"comment_id": "22582ed5-6df8-4c39-b1ac-8faa4a57c34d", "listing_id": "fa2a0fb6-7cf0-4efc-b073-3c1e6c945dcc"}	t	2026-05-12 09:49:35.840334+00
092047bd-5ccf-4b2b-87f6-0c13991467d3	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	order_paid	You Made a Sale!	"Negotiable" was purchased for A$80.00. Ship it to earn A$70.40.	{"order_id": "66951df6-4aef-4f9b-80ec-fbf21df1a9a4", "listing_id": "482f9f26-ba55-4415-a7a9-16b07e593193"}	t	2026-05-13 14:12:18.573333+00
a7827534-50ed-4e24-821b-4ac85a73c589	5a8c6efd-fbef-4156-85f4-09ce157f3b92	order_shipped	Your Order Has Shipped!	"Negotiable" is on its way. Tracking: 12443	{"order_id": "66951df6-4aef-4f9b-80ec-fbf21df1a9a4", "listing_id": "482f9f26-ba55-4415-a7a9-16b07e593193"}	t	2026-05-13 14:14:10.056361+00
7d1886ac-60c2-40d3-81da-efba3cc39bb2	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	order_delivered	Order Delivered	"Negotiable" has been delivered to the buyer.	{"order_id": "66951df6-4aef-4f9b-80ec-fbf21df1a9a4", "listing_id": "482f9f26-ba55-4415-a7a9-16b07e593193"}	t	2026-05-13 14:18:18.569774+00
f921e809-4eff-413e-b0b5-04960eaa3b72	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	listing_comment	New comment on your listing	Aditya Rathi commented on "Dummy Lehemga"	{"comment_id": "cd5c7fc1-a657-4337-982a-a12d37699ba5", "listing_id": "fa2a0fb6-7cf0-4efc-b073-3c1e6c945dcc"}	t	2026-05-13 14:38:04.29687+00
43787e75-f441-46f4-9311-f803906a9f58	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	listing_comment	New comment on your listing	Aditya Rathi commented on "Dummy Lehemga"	{"comment_id": "fb89b2c6-b405-4f1e-a388-5a64e553685e", "listing_id": "fa2a0fb6-7cf0-4efc-b073-3c1e6c945dcc"}	f	2026-05-13 14:42:12.638536+00
f839852c-d0fb-45b3-8e96-6a550dc42e96	5a8c6efd-fbef-4156-85f4-09ce157f3b92	review_revealed	Reviews are in!	See what testingBolna said about your transaction	{"order_id": "66951df6-4aef-4f9b-80ec-fbf21df1a9a4", "listing_id": "482f9f26-ba55-4415-a7a9-16b07e593193"}	f	2026-05-13 15:20:19.151601+00
fdb7ce8a-9d88-441d-89d0-9485ae65d221	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	review_revealed	Reviews are in!	See what Aditya Rathi said about your transaction	{"order_id": "66951df6-4aef-4f9b-80ec-fbf21df1a9a4", "listing_id": "482f9f26-ba55-4415-a7a9-16b07e593193"}	t	2026-05-13 15:20:19.120566+00
a13cb79f-8fe0-42c7-bbd5-c0326ab486f5	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	order_paid	You Made a Sale!	"Dummy suit" was purchased for A$500.00. Ship it to earn A$440.00.	{"order_id": "5453675e-e6a6-446a-9038-662057a3b4a9", "listing_id": "935b993c-9a19-4e6f-811f-57a6b7819798"}	f	2026-05-13 16:08:10.984129+00
9aced6c2-fdf7-4654-8afb-af2fecf936bf	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	new_message	New message from Aditya Rathi	Hi	{"listing_id": "935b993c-9a19-4e6f-811f-57a6b7819798", "conversation_id": "3797982f-aada-4097-b78a-53a14a99c879"}	t	2026-05-13 16:25:50.49622+00
e78cc1d8-fc1b-4456-bb31-fc61be5c5d5f	5a8c6efd-fbef-4156-85f4-09ce157f3b92	new_message	New message from testingBolna	Wassup	{"listing_id": "935b993c-9a19-4e6f-811f-57a6b7819798", "conversation_id": "3797982f-aada-4097-b78a-53a14a99c879"}	f	2026-05-13 16:41:26.590304+00
1aad34d3-09de-48ae-84f3-60fe742c8387	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	new_message	New message from Aditya Rathi	Yo	{"listing_id": "935b993c-9a19-4e6f-811f-57a6b7819798", "conversation_id": "3797982f-aada-4097-b78a-53a14a99c879"}	f	2026-05-13 16:42:49.975078+00
\.


--
-- Data for Name: offers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.offers (id, listing_id, buyer_id, seller_id, amount, currency, status, round, parent_offer_id, expires_at, created_at, updated_at) FROM stdin;
d7a140cb-a260-4c4f-a546-90c3273adad6	db874dbf-7781-4223-894c-474e875258ca	17e9238d-374e-4c91-a838-b8407a0c5a89	58b4d340-e364-4053-ae67-254fb4988586	20000	AUD	pending	1	\N	2026-03-18 13:16:10.636+00	2026-03-16 13:16:10.747801+00	2026-03-16 13:16:10.747801+00
3df93efa-7c2f-4ecd-a3e3-87b59539a311	a80f4f7b-c5cb-44bb-9271-14d2beca2964	17e9238d-374e-4c91-a838-b8407a0c5a89	58b4d340-e364-4053-ae67-254fb4988586	2000	AUD	pending	1	\N	2026-03-20 07:50:56.443+00	2026-03-18 07:50:56.559486+00	2026-03-18 07:50:56.559486+00
a6a913a7-710d-4f5c-97bd-4a3dd661f977	5ee30352-5c13-49b8-99de-e44158bf0e60	21d6b9d9-2707-4c4a-93e7-e4339a725688	17e9238d-374e-4c91-a838-b8407a0c5a89	15000	USD	countered	1	\N	2026-04-07 14:24:26.465+00	2026-04-05 14:24:26.584526+00	2026-04-05 14:26:18.984369+00
ba28ab96-7c8c-45cd-ac58-d30ceb707d30	5ee30352-5c13-49b8-99de-e44158bf0e60	21d6b9d9-2707-4c4a-93e7-e4339a725688	17e9238d-374e-4c91-a838-b8407a0c5a89	16000	USD	accepted	2	a6a913a7-710d-4f5c-97bd-4a3dd661f977	2026-04-09 12:49:14.76+00	2026-04-05 14:26:19.189993+00	2026-04-08 12:49:14.835761+00
\.


--
-- Data for Name: orders; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.orders (id, order_number, listing_id, buyer_id, seller_id, buyer_email, offer_id, amount, currency, commission_rate, commission_amount, seller_payout, stripe_payment_intent_id, stripe_checkout_session_id, status, shipping_tracking_number, shipping_carrier, shipped_at, delivered_at, completed_at, auto_complete_at, created_at, updated_at, total_amount) FROM stdin;
66951df6-4aef-4f9b-80ec-fbf21df1a9a4	KIF-20260513-6DJ9	482f9f26-ba55-4415-a7a9-16b07e593193	5a8c6efd-fbef-4156-85f4-09ce157f3b92	c7b5b811-acbe-44a0-8bb4-51483c01f4b4		\N	8000	AUD	12.00	960	7040	pi_3TWdW6Ju7a8QvsLB1ZsQMZQO	\N	complete	12443	FedEx	2026-05-13 14:14:09.692+00	2026-05-13 14:18:18.25+00	2026-05-13 12:00:00+00	2026-05-20 14:14:09.692+00	2026-05-13 14:12:18.192761+00	2026-05-13 14:45:53.159133+00	\N
5453675e-e6a6-446a-9038-662057a3b4a9	KIF-20260513-X0CB	935b993c-9a19-4e6f-811f-57a6b7819798	5a8c6efd-fbef-4156-85f4-09ce157f3b92	c7b5b811-acbe-44a0-8bb4-51483c01f4b4		\N	50000	AUD	12.00	6000	44000	pi_3TWfKCJu7a8QvsLB0j9P0I4x	\N	paid	\N	\N	\N	\N	\N	\N	2026-05-13 16:08:10.660528+00	2026-05-13 16:08:10.660528+00	\N
\.


--
-- Data for Name: referral_codes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.referral_codes (id, user_id, code, created_at, disabled, disabled_at, disabled_by) FROM stdin;
2fdb6b42-8b91-4936-9d82-fc00aafbdb51	17e9238d-374e-4c91-a838-b8407a0c5a89	17E9238D	2026-03-20 13:16:52.095809+00	f	\N	\N
336493d5-b360-4f4d-b2dc-01e1fcb61a9e	d5f157e6-8f8b-4c6e-8b62-1e6d89ff51b1	PALLAVI	2026-03-30 08:31:05.124101+00	f	\N	\N
f4bbc794-9822-4b30-9fb4-7da1fc75922e	21d6b9d9-2707-4c4a-93e7-e4339a725688	CLAUDINA	2026-04-05 14:21:51.371404+00	f	\N	\N
9d78caf8-178a-48c7-8869-c309b1a441c7	d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3	D0E34BF5	2026-04-10 08:36:14.817643+00	f	\N	\N
917a98e9-ad69-40a3-931a-e61dc524829c	5a8c6efd-fbef-4156-85f4-09ce157f3b92	ADITYA	2026-04-29 08:56:56.380932+00	f	\N	\N
0fa0fcce-a73b-499d-ad62-58f0828fb01c	8b200565-6ca3-4814-8213-fe034d2f5b08	ADITYA756	2026-05-11 11:28:15.505227+00	f	\N	\N
27b17dd5-73f0-469b-9ebb-0f9bf5518540	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	TESTINGBOLNA	2026-05-12 07:27:02.228971+00	f	\N	\N
720ab711-d5ea-4041-b75b-c82209ef73c4	da8ac193-69dc-4506-be9f-05e7ff94690f	ADITYA557	2026-05-17 18:25:54.921248+00	f	\N	\N
\.


--
-- Data for Name: referral_credits; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.referral_credits (id, user_id, referral_code_id, amount, type, status, redeemed_at, expires_at, created_at, referral_id, order_id, redeemed_order_id) FROM stdin;
\.


--
-- Data for Name: referrals; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.referrals (id, referrer_id, referred_id, referral_code_id, qualifying_order_id, status, created_at, qualified_at) FROM stdin;
\.


--
-- Data for Name: rental_blackouts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.rental_blackouts (id, listing_id, start_date, end_date, reason, created_at) FROM stdin;
\.


--
-- Data for Name: rental_bookings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.rental_bookings (id, listing_id, renter_id, lender_id, start_date, end_date, daily_rate, total_rental_amount, cleaning_fee, security_deposit, status, stripe_payment_intent_id, stripe_deposit_payment_intent_id, deposit_released, created_at, updated_at, stripe_setup_intent_id, stripe_payment_method_id, shipping_tracking_number, return_tracking_number, damage_claim_description, damage_claim_photos) FROM stdin;
\.


--
-- Data for Name: reports; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.reports (id, reporter_id, target_type, target_id, category, details, status, created_at) FROM stdin;
\.


--
-- Data for Name: reviews; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.reviews (id, order_id, reviewer_id, reviewee_id, rating, comment, reviewer_role, visible, created_at, revealed_at, seller_reply, seller_reply_at, updated_at) FROM stdin;
86f450a2-1897-44f0-bb0e-774e9c1b8cd9	66951df6-4aef-4f9b-80ec-fbf21df1a9a4	5a8c6efd-fbef-4156-85f4-09ce157f3b92	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	5	Okayish	buyer	f	2026-05-13 15:19:37.818696+00	2026-05-13 15:20:18.549+00	\N	\N	2026-05-13 15:19:37.818696+00
e9ad408a-91c0-489d-a92c-3f9540bd3f0c	66951df6-4aef-4f9b-80ec-fbf21df1a9a4	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	5a8c6efd-fbef-4156-85f4-09ce157f3b92	5	Best buyer	seller	f	2026-05-13 15:20:18.408276+00	2026-05-13 15:20:18.549+00	\N	\N	2026-05-13 15:20:18.408276+00
\.


--
-- Data for Name: search_queries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.search_queries (id, term, user_id, filters, result_count, created_at) FROM stdin;
953673e6-77c3-4e19-81e2-ae2053bd5475		d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3	{"category": "Suit/Salwar"}	0	2026-03-20 10:24:36.978576+00
aeb0b74f-7c2e-43c4-b0ba-ffbcae87b398		d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3	{"category": "Suit/Salwar"}	0	2026-03-20 10:24:44.298816+00
4da49495-0e69-4188-b84f-12430b7e2e35		d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3	{"category": "Lehenga"}	5	2026-03-20 13:05:45.028989+00
9bc2bd81-ca08-4552-83d1-30a2411d71dd	Lehenga	17e9238d-374e-4c91-a838-b8407a0c5a89	{}	5	2026-03-20 13:15:12.533915+00
0e850989-96e9-46f2-bcc3-c40f9ed757e9	Lehenga	17e9238d-374e-4c91-a838-b8407a0c5a89	{}	5	2026-03-20 23:20:07.426067+00
6f48f8ea-a81f-42c8-8e74-b70cb35a2d61		17e9238d-374e-4c91-a838-b8407a0c5a89	{"category": "Saree"}	0	2026-03-20 23:23:49.118325+00
fd569020-0cc4-4143-af36-dde6d2de5299	Lehenga	17e9238d-374e-4c91-a838-b8407a0c5a89	{}	5	2026-03-21 10:23:33.876579+00
8e6e8521-5965-499a-a8f4-620e38bdfd66	Lehenga	17e9238d-374e-4c91-a838-b8407a0c5a89	{}	5	2026-03-21 11:58:42.091244+00
779f18bf-2cfc-4e15-8254-657773cf575e	Wedding Saree	17e9238d-374e-4c91-a838-b8407a0c5a89	{}	0	2026-03-21 11:59:42.493432+00
0a3ef411-caad-44f8-9b44-2a8518dc8b33	Lehenga	d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3	{}	5	2026-03-24 04:32:18.67252+00
57a3bcba-2980-47bc-a246-8a46b1912736		17e9238d-374e-4c91-a838-b8407a0c5a89	{"category": "Lehenga"}	5	2026-03-24 10:27:32.718104+00
052dc543-6ee0-438b-b35b-4ab021e12883	Lehenga	17e9238d-374e-4c91-a838-b8407a0c5a89	{}	5	2026-03-24 10:37:41.884107+00
64a39b23-f35a-42f2-991c-ba9a02638042	Party Wear	17e9238d-374e-4c91-a838-b8407a0c5a89	{}	0	2026-03-24 10:41:26.510621+00
75c11449-f5f7-4da8-94f5-fec8da94bd3b	Lehenga	d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3	{}	5	2026-03-24 13:02:56.573956+00
1c485c36-3c07-4a45-b5c5-75020925c107		17e9238d-374e-4c91-a838-b8407a0c5a89	{"category": "Lehenga"}	5	2026-03-24 13:13:42.386206+00
90a61aa7-51a0-4f34-a436-4f2f2d5a7411	Lehenga	17e9238d-374e-4c91-a838-b8407a0c5a89	{}	5	2026-03-24 13:17:28.58896+00
b00fe9a4-5f49-496b-9699-e52e4886b58d	Lehenga	17e9238d-374e-4c91-a838-b8407a0c5a89	{}	5	2026-03-30 08:30:04.909807+00
e7ef2ee0-3bde-4b57-8ecd-cd49c0b8db0c	Lehenga	d5f157e6-8f8b-4c6e-8b62-1e6d89ff51b1	{}	5	2026-03-30 08:42:29.549093+00
4865c7e1-2216-4a9a-9428-151ce769959e	Lehenga	d5f157e6-8f8b-4c6e-8b62-1e6d89ff51b1	{}	5	2026-03-30 09:07:06.363353+00
c28da44c-c550-419e-9b73-eafb2acd34e3	Wedding Saree	d5f157e6-8f8b-4c6e-8b62-1e6d89ff51b1	{}	0	2026-03-30 09:11:03.894956+00
e6ea5778-ea78-46cd-8e6a-0017bfffae18	Lehenga	d5f157e6-8f8b-4c6e-8b62-1e6d89ff51b1	{}	5	2026-03-30 09:14:31.866851+00
423e8730-6f5d-43bb-883a-c1b2f41ad711	Lehenga	17e9238d-374e-4c91-a838-b8407a0c5a89	{}	5	2026-03-30 10:20:27.123748+00
b4c29cfa-3574-4ee3-afd1-9386f828ad3c	Lehenga	17e9238d-374e-4c91-a838-b8407a0c5a89	{}	5	2026-03-30 11:10:54.028672+00
86f93d62-d827-4c57-b09e-2f4a429c9cfc		17e9238d-374e-4c91-a838-b8407a0c5a89	{"category": "Lehenga"}	5	2026-03-30 11:11:04.752145+00
26016282-7377-48c6-baf9-8f656bd6bda7		17e9238d-374e-4c91-a838-b8407a0c5a89	{"category": "Sharara"}	0	2026-03-30 11:14:46.405744+00
642631fc-d924-4c73-b4d0-31b509f0ea0d		17e9238d-374e-4c91-a838-b8407a0c5a89	{"category": "Sharara"}	0	2026-03-30 11:14:51.848211+00
c148101f-b1a8-47f3-ba03-80a470ee9e66		17e9238d-374e-4c91-a838-b8407a0c5a89	{"category": "Sharara", "occasion": "Eid,Wedding"}	0	2026-03-30 11:14:59.153738+00
79f1b8c5-32a6-452a-b464-5b9b43314ce5	Lehenga	17e9238d-374e-4c91-a838-b8407a0c5a89	{}	5	2026-03-31 08:50:37.609635+00
8463e7c1-5a19-450c-a41a-7a07ace7ed2e	Lehenga	17e9238d-374e-4c91-a838-b8407a0c5a89	{}	5	2026-03-31 09:59:19.183231+00
8c8f4318-73c6-4a40-897b-143d0f63a9a8	Lehenga	4ba560b1-1e4a-4343-be20-e6fbc2a095ba	{}	5	2026-04-01 08:05:39.458537+00
715f7912-5d18-43cf-bec1-ed4c79bd0588	saree	\N	{}	0	2026-04-01 16:15:53.308603+00
b8c4eb60-6b23-424e-beb0-2932c9281682		\N	{}	6	2026-04-01 16:15:53.34929+00
1c611537-73b4-43d7-b2b9-6477b4e5fb73		\N	{}	6	2026-04-01 16:15:53.402963+00
e7c940dc-d154-412b-a7f1-4ae2f45c37e8	<script>alert(1)</script>	\N	{}	0	2026-04-01 16:15:53.584222+00
a5bb25cc-9d2e-4610-bdcf-117a5671b826	Lehenga	17e9238d-374e-4c91-a838-b8407a0c5a89	{}	7	2026-04-02 09:16:08.987554+00
1a6c522e-ea20-4514-bbb3-53671b7d7964		17e9238d-374e-4c91-a838-b8407a0c5a89	{"category": "Lehenga"}	7	2026-04-02 09:16:47.393545+00
180b3626-1672-4120-bbd8-7e897de8c71e	Lehenga	17e9238d-374e-4c91-a838-b8407a0c5a89	{}	9	2026-04-02 10:00:45.938628+00
e137c7fb-c81e-4c66-8245-3bf5e064e050		17e9238d-374e-4c91-a838-b8407a0c5a89	{"category": "Lehenga"}	9	2026-04-02 10:12:13.926551+00
5b0a6050-1455-4919-a5c5-f0aa2358677f	Lehenga	d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3	{}	9	2026-04-05 12:12:27.343805+00
788b0f80-c3a8-4d86-9a5c-29eb222b5ceb		17e9238d-374e-4c91-a838-b8407a0c5a89	{"category": "Lehenga"}	9	2026-04-05 13:44:51.277397+00
51126e31-3d66-4777-8515-490a810956ce		17e9238d-374e-4c91-a838-b8407a0c5a89	{"category": "Lehenga"}	9	2026-04-05 13:44:59.801126+00
55037b23-80cb-4f05-9ca4-beb7b1530615		17e9238d-374e-4c91-a838-b8407a0c5a89	{"category": "Lehenga"}	9	2026-04-05 13:45:04.738577+00
356724d9-44f7-48c4-b412-2fcd93f1f6fc		17e9238d-374e-4c91-a838-b8407a0c5a89	{"size": "AU8 / UK6 / US9 / EU39", "category": "Footwear", "occasion": "Wedding party", "condition": "Pre-loved"}	0	2026-04-05 13:49:44.568075+00
2e0f7d30-2cd4-47c8-85b7-c02ec19c34a6		17e9238d-374e-4c91-a838-b8407a0c5a89	{"size": "AU8 / UK6 / US9 / EU39", "occasion": "Wedding party", "condition": "Pre-loved"}	0	2026-04-05 13:49:52.986735+00
4e0b8cec-e6c1-4f8d-a033-9ebe25292f92		17e9238d-374e-4c91-a838-b8407a0c5a89	{"size": "AU8 / UK6 / US9 / EU39", "occasion": "Wedding party"}	0	2026-04-05 13:49:53.531918+00
1a99980b-2654-432a-ad6c-4fb7a3ab740e		17e9238d-374e-4c91-a838-b8407a0c5a89	{"occasion": "Wedding party"}	0	2026-04-05 13:50:51.533009+00
6d130090-966e-4993-96f7-b92c3eb3fb5d		17e9238d-374e-4c91-a838-b8407a0c5a89	{}	0	2026-04-05 13:50:51.678959+00
6e358a06-49e1-4061-af48-b71ebd0768ad		17e9238d-374e-4c91-a838-b8407a0c5a89	{}	0	2026-04-05 13:50:51.869137+00
8af44c7a-3aec-4661-9354-4d95b5ab1163		17e9238d-374e-4c91-a838-b8407a0c5a89	{}	8	2026-04-05 13:50:52.235997+00
5e06160c-5a01-4989-ab5d-01bfb37370c3	Lehenga	21d6b9d9-2707-4c4a-93e7-e4339a725688	{}	8	2026-04-05 14:34:34.032025+00
61c461e1-dc08-470e-ae52-ed30222e4b3f		17e9238d-374e-4c91-a838-b8407a0c5a89	{"category": "Lehenga"}	8	2026-04-06 23:19:22.035853+00
051c927a-30cb-4541-a6a8-09cf9b7123f4	Anarkali	17e9238d-374e-4c91-a838-b8407a0c5a89	{"market": "AU"}	0	2026-04-07 10:55:46.348763+00
e62656d9-71cf-4ce2-a97f-bed7ebf52c90	Lehenga	17e9238d-374e-4c91-a838-b8407a0c5a89	{"market": "AU"}	5	2026-04-08 12:56:41.534423+00
db22655e-4281-4048-8332-2eede5d0d1a7	Lehenga	17e9238d-374e-4c91-a838-b8407a0c5a89	{"category": "Jewellery", "condition": "New with tags"}	0	2026-04-08 12:56:49.432774+00
6388d080-2d2b-42cd-abd1-019d2946d876	Lehenga	17e9238d-374e-4c91-a838-b8407a0c5a89	{"market": "AU"}	5	2026-04-09 13:35:46.750025+00
9ae42ada-5475-42a7-a1dd-8935a24aa673	Wedding Saree	d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3	{"market": "AU"}	0	2026-04-10 08:18:49.097785+00
fbcc7b5f-fbbb-473e-bcd1-fe2ef1fb8c5e	Party Wear	17e9238d-374e-4c91-a838-b8407a0c5a89	{"market": "AU"}	0	2026-04-10 14:19:39.859677+00
17243cde-0332-4ffd-9a9e-bfc323078524	Lehenga	21d6b9d9-2707-4c4a-93e7-e4339a725688	{"market": "US"}	0	2026-04-12 08:47:33.868798+00
bd27c6f1-7a6c-47b3-9b95-eccc16c7a389	Lehenga	21d6b9d9-2707-4c4a-93e7-e4339a725688	{"market": "AU"}	5	2026-04-12 08:47:41.752082+00
8f8cf59b-e4dc-4405-b26b-b202a56d415f		4ba560b1-1e4a-4343-be20-e6fbc2a095ba	{"market": "AU", "category": "Lehenga"}	5	2026-04-12 20:04:18.837117+00
c11aff4f-2f67-4029-814c-9522cbcac13c		4ba560b1-1e4a-4343-be20-e6fbc2a095ba	{"market": "AU", "category": "Blouse"}	0	2026-04-19 16:50:59.635375+00
0d41d917-dd75-4aaa-941f-386688a96bf6	Lehenga	\N	{"market": "US"}	0	2026-04-29 08:56:30.349585+00
2ce47809-ae14-4087-a4b8-38c6879ff300	Other	5a8c6efd-fbef-4156-85f4-09ce157f3b92	{"market": "US"}	0	2026-04-29 09:00:35.864267+00
18b9801d-a10b-4560-8844-1375d7a2c5fa		\N	{"market": "US", "category": "Lehenga"}	0	2026-05-01 04:01:09.629351+00
b8ab0808-16b1-409b-b15f-aa5328093229	Lehenga	d5f157e6-8f8b-4c6e-8b62-1e6d89ff51b1	{"market": "AU"}	4	2026-05-03 11:40:39.226609+00
7e3342eb-d52f-4883-801c-aa9083fd0dfd	Wedding Saree	d5f157e6-8f8b-4c6e-8b62-1e6d89ff51b1	{"market": "AU"}	0	2026-05-03 11:51:44.622752+00
a5bc273e-bd06-4e0c-9cef-28c07e008c07	Wedding Saree	d5f157e6-8f8b-4c6e-8b62-1e6d89ff51b1	{"market": "US"}	0	2026-05-03 11:51:50.413245+00
d9327954-ce0e-49f3-90c1-49ee6f048436	Wedding Saree	d5f157e6-8f8b-4c6e-8b62-1e6d89ff51b1	{"market": "NZ"}	0	2026-05-03 11:51:54.765638+00
66416ff8-b009-4b9a-a53b-5827e0de629d		5a8c6efd-fbef-4156-85f4-09ce157f3b92	{"market": "US", "category": "Lehenga"}	0	2026-05-12 08:09:42.6654+00
f8520fa1-c878-4235-9b04-d3255475dec9		5a8c6efd-fbef-4156-85f4-09ce157f3b92	{"market": "AU", "category": "Lehenga"}	4	2026-05-12 08:15:26.025217+00
e6253130-c628-42b1-9b44-ed74ba1139f0	Lehenga	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	{"market": "AU"}	5	2026-05-12 08:45:53.984965+00
947c5114-c903-4786-8066-e0fe5d50f5f5	Elegant Dark Green Floral Lehenga Choli Set with Sequin & Thread Embroidery - Perfect for Weddings & Festive Occasions	5a8c6efd-fbef-4156-85f4-09ce157f3b92	{"market": "AU"}	0	2026-05-12 10:34:51.255032+00
edece2d0-03fa-4356-a62b-34db7f42f29a	Lehenga	5a8c6efd-fbef-4156-85f4-09ce157f3b92	{"market": "AU"}	5	2026-05-12 10:39:38.84629+00
21e235bc-3f26-4248-a2eb-eae1be7ac7a7	Lehenga	5a8c6efd-fbef-4156-85f4-09ce157f3b92	{"market": "AU", "category": "Lehenga"}	5	2026-05-12 10:47:32.163999+00
e8947785-3830-4b50-a69d-9bdadc81fd4d	Lehenga	5a8c6efd-fbef-4156-85f4-09ce157f3b92	{"market": "AU"}	6	2026-05-13 15:56:14.556573+00
\.


--
-- Data for Name: seller_follows; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.seller_follows (id, follower_id, seller_id, created_at) FROM stdin;
9f9e015e-2c41-488d-97cb-8494493284bc	d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3	17e9238d-374e-4c91-a838-b8407a0c5a89	2026-04-05 12:07:04.286474+00
c64d3e40-0738-4f76-87c8-4a4c06a69dbf	5a8c6efd-fbef-4156-85f4-09ce157f3b92	c7b5b811-acbe-44a0-8bb4-51483c01f4b4	2026-05-12 09:50:33.726369+00
\.


--
-- Data for Name: wishlist_folders; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.wishlist_folders (id, user_id, name, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: wishlists; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.wishlists (id, user_id, guest_token, listing_id, folder_id, created_at) FROM stdin;
9f21d942-9a6d-4705-bf09-9c7423fa5781	17e9238d-374e-4c91-a838-b8407a0c5a89	\N	db874dbf-7781-4223-894c-474e875258ca	\N	2026-03-16 13:16:39.141111+00
2e0554d1-ef77-4fa7-9476-b94490beadaf	17e9238d-374e-4c91-a838-b8407a0c5a89	\N	a80f4f7b-c5cb-44bb-9271-14d2beca2964	\N	2026-03-16 13:16:39.807372+00
a0b45d32-aa33-4920-bfa1-3baac8580454	d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3	\N	3671d8c4-feef-4dd7-90e4-a6ea4586e249	\N	2026-03-20 13:05:52.402579+00
801a7e20-90ba-4810-a345-8e27d355bf8f	17e9238d-374e-4c91-a838-b8407a0c5a89	\N	0fc846bc-5141-4717-9b64-61bc65fcea9f	\N	2026-03-24 10:23:22.277355+00
85eb8d35-18ae-4bd7-855a-54c691fd8785	17e9238d-374e-4c91-a838-b8407a0c5a89	\N	3671d8c4-feef-4dd7-90e4-a6ea4586e249	\N	2026-03-24 10:30:05.048132+00
a9f1202e-a752-4689-b4bb-381ec15e9f09	d0e34bf5-3086-4b7f-bfa6-3ea41b6345b3	\N	5ee30352-5c13-49b8-99de-e44158bf0e60	\N	2026-04-05 12:07:18.397216+00
bc9b29a9-3649-4fdb-9249-2cf6f0744d47	21d6b9d9-2707-4c4a-93e7-e4339a725688	\N	5ee30352-5c13-49b8-99de-e44158bf0e60	\N	2026-04-05 14:24:02.642371+00
d03d1a79-616d-4d8a-b59c-a9b902097cd1	5a8c6efd-fbef-4156-85f4-09ce157f3b92	\N	fa2a0fb6-7cf0-4efc-b073-3c1e6c945dcc	\N	2026-05-12 09:46:18.545846+00
\.


--
-- Name: desi_term_aliases_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.desi_term_aliases_id_seq', 27, true);


--
-- Name: exchange_rates_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.exchange_rates_id_seq', 414, true);


--
-- PostgreSQL database dump complete
--

\unrestrict B166JAeC4myxUhTufV4kB2gaaLraigAZqkf9hQvUOLMLz9XsHqv3WNXoP03yki0

