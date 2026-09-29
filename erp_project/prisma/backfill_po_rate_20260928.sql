-- Backfill unit_price / total_amount on POs raised 2026-09-28.
--
-- WHAT
--   99 POs of the 119 raised that day and still unpriced.
--   The other 20 have no agreed rate at all and stay NULL.
--
-- WHY
--   They were raised before the rate was resolved server-side
--   (lib/po/po-rate.ts), so they carried no rate on the PO document, the
--   summary mail or the invoice three-way match.
--
-- WHERE THE NUMBERS COME FROM
--   agreedRatesByMfg(mfg_id) — today's agreed cost, the same figure the invoice
--   match compares against. Rounded to paise BEFORE multiplying, so rate x qty
--   equals the stored amount.
--
-- ⚠ 42 of these are PARTIAL rates: the recipe has unrated RM/PM lines and
--   selectMaterialCostByMfg counts those as zero, so the rate is understated.
--   Each is marked below. None fell under 1.00. Re-run once the cost masters
--   are filled.
--
-- RE-RUNNABLE
--   Yes. Each statement is guarded by `unit_price IS NULL`.
--
-- APPLIED TO
--   prod 2026-09-29.

UPDATE purchase_orders SET unit_price = 62.98, total_amount = 20141633.8
 WHERE id = 754 AND unit_price IS NULL;  -- MCAFF-PO-202609-001 Mcaf396_WB
UPDATE purchase_orders SET unit_price = 67.79, total_amount = 23134625.51
 WHERE id = 755 AND unit_price IS NULL;  -- MCAFF-PO-202609-002 Mcaf408_WB
UPDATE purchase_orders SET unit_price = 73.46, total_amount = 22067384
 WHERE id = 756 AND unit_price IS NULL;  -- HYP-PO-202609-001 HYPMUBX038F050
UPDATE purchase_orders SET unit_price = 84.02, total_amount = 3827111
 WHERE id = 757 AND unit_price IS NULL;  -- MCAFF-PO-202609-003 Mcaf401
UPDATE purchase_orders SET unit_price = 75.89, total_amount = 1032104
 WHERE id = 758 AND unit_price IS NULL;  -- MCAFF-PO-202609-004 Mcaf401
UPDATE purchase_orders SET unit_price = 72.09, total_amount = 3921696
 WHERE id = 760 AND unit_price IS NULL;  -- MCAFF-PO-202609-006 Mcaf401 — PARTIAL, 5 unrated line(s)
UPDATE purchase_orders SET unit_price = 62.7, total_amount = 3959505
 WHERE id = 762 AND unit_price IS NULL;  -- MCAFF-PO-202609-008 MCaf370 — PARTIAL, 4 unrated line(s)
UPDATE purchase_orders SET unit_price = 79.5, total_amount = 9023250
 WHERE id = 763 AND unit_price IS NULL;  -- HYP-PO-202609-002 HYPMUBX0046F0030
UPDATE purchase_orders SET unit_price = 26.42, total_amount = 6393640
 WHERE id = 765 AND unit_price IS NULL;  -- MCAFF-PO-202609-010 50MCaf41_WB
UPDATE purchase_orders SET unit_price = 14.87, total_amount = 2180239.4
 WHERE id = 766 AND unit_price IS NULL;  -- HYP-PO-202609-003 HYPMUWB0017F0015_N1
UPDATE purchase_orders SET unit_price = 44.62, total_amount = 95933
 WHERE id = 768 AND unit_price IS NULL;  -- MCAFF-PO-202609-012 Mcaf397_WB — PARTIAL, 8 unrated line(s)
UPDATE purchase_orders SET unit_price = 51.04, total_amount = 1360216
 WHERE id = 769 AND unit_price IS NULL;  -- MCAFF-PO-202609-013 Mcaf397_WB — PARTIAL, 2 unrated line(s)
UPDATE purchase_orders SET unit_price = 39.92, total_amount = 1686620
 WHERE id = 770 AND unit_price IS NULL;  -- MCAFF-PO-202609-014 MCaf383_WB_N1 — PARTIAL, 2 unrated line(s)
UPDATE purchase_orders SET unit_price = 46.15, total_amount = 2741310
 WHERE id = 771 AND unit_price IS NULL;  -- MCAFF-PO-202609-015 Mcaf406 — PARTIAL, 6 unrated line(s)
UPDATE purchase_orders SET unit_price = 55.61, total_amount = 9142284
 WHERE id = 772 AND unit_price IS NULL;  -- HYP-PO-202609-004 HYPMUBX027F100 — PARTIAL, 1 unrated line(s)
UPDATE purchase_orders SET unit_price = 51.17, total_amount = 3581900
 WHERE id = 773 AND unit_price IS NULL;  -- MCAFF-PO-202609-016 15MCaf62
UPDATE purchase_orders SET unit_price = 80.85, total_amount = 10530712.5
 WHERE id = 774 AND unit_price IS NULL;  -- HYP-PO-202609-005 HYPMUBX004F050
UPDATE purchase_orders SET unit_price = 4.64, total_amount = 92800
 WHERE id = 775 AND unit_price IS NULL;  -- HYP-PO-202609-006 HYPMUBX0065F0050 — PARTIAL, 17 unrated line(s)
UPDATE purchase_orders SET unit_price = 37.41, total_amount = 2053809
 WHERE id = 776 AND unit_price IS NULL;  -- HYP-PO-202609-007 HYPMUBX017F100
UPDATE purchase_orders SET unit_price = 39.86, total_amount = 1375170
 WHERE id = 778 AND unit_price IS NULL;  -- MCAFF-PO-202609-018 MCFMUBX0418F0100
UPDATE purchase_orders SET unit_price = 62.3, total_amount = 2971710
 WHERE id = 779 AND unit_price IS NULL;  -- MCAFF-PO-202609-019 MCFMUWB0417F0175
UPDATE purchase_orders SET unit_price = 72.88, total_amount = 4372800
 WHERE id = 780 AND unit_price IS NULL;  -- HYP-PO-202609-008 HYPMUBX0066F0050
UPDATE purchase_orders SET unit_price = 57.02, total_amount = 2280800
 WHERE id = 782 AND unit_price IS NULL;  -- HYP-PO-202609-009 HYPMUBX017F200
UPDATE purchase_orders SET unit_price = 66.21, total_amount = 2803993.5
 WHERE id = 783 AND unit_price IS NULL;  -- MCAFF-PO-202609-021 Mcaf409_WB
UPDATE purchase_orders SET unit_price = 61.35, total_amount = 1742340
 WHERE id = 784 AND unit_price IS NULL;  -- MCAFF-PO-202609-022 MCFMUWB0415F0175
UPDATE purchase_orders SET unit_price = 66.25, total_amount = 294481.25
 WHERE id = 785 AND unit_price IS NULL;  -- MCAFF-PO-202609-023 MCaf371
UPDATE purchase_orders SET unit_price = 51.67, total_amount = 1715444
 WHERE id = 786 AND unit_price IS NULL;  -- HYP-PO-202609-010 HYPMUBX004F030 — PARTIAL, 6 unrated line(s)
UPDATE purchase_orders SET unit_price = 17.99, total_amount = 809550
 WHERE id = 788 AND unit_price IS NULL;  -- HYP-PO-202609-011 HYPMUBX022F010 — PARTIAL, 16 unrated line(s)
UPDATE purchase_orders SET unit_price = 33.55, total_amount = 436150
 WHERE id = 789 AND unit_price IS NULL;  -- MCAFF-PO-202609-025 MCaf41_WB
UPDATE purchase_orders SET unit_price = 43.42, total_amount = 374063.3
 WHERE id = 790 AND unit_price IS NULL;  -- MCAFF-PO-202609-026 MCaf299
UPDATE purchase_orders SET unit_price = 52.08, total_amount = 921034.8
 WHERE id = 791 AND unit_price IS NULL;  -- MCAFF-PO-202609-027 Mcaf404 — PARTIAL, 6 unrated line(s)
UPDATE purchase_orders SET unit_price = 39.13, total_amount = 897563.94
 WHERE id = 792 AND unit_price IS NULL;  -- MCAFF-PO-202609-028 MCFMUBX0416F0100
UPDATE purchase_orders SET unit_price = 70.06, total_amount = 1261080
 WHERE id = 795 AND unit_price IS NULL;  -- MCAFF-PO-202609-030 Mcaf407 — PARTIAL, 1 unrated line(s)
UPDATE purchase_orders SET unit_price = 45.52, total_amount = 2048400
 WHERE id = 796 AND unit_price IS NULL;  -- MCAFF-PO-202609-031 MCFGKIT085F0003_S — PARTIAL, 2 unrated line(s)
UPDATE purchase_orders SET unit_price = 15.89, total_amount = 209112.4
 WHERE id = 797 AND unit_price IS NULL;  -- MCAFF-PO-202609-032 15SMCaf40_N1
UPDATE purchase_orders SET unit_price = 33.99, total_amount = 135960
 WHERE id = 798 AND unit_price IS NULL;  -- MCAFF-PO-202609-033 Mcaf398 — PARTIAL, 14 unrated line(s)
UPDATE purchase_orders SET unit_price = 65.56, total_amount = 1048960
 WHERE id = 799 AND unit_price IS NULL;  -- MCAFF-PO-202609-034 Mcaf398 — PARTIAL, 1 unrated line(s)
UPDATE purchase_orders SET unit_price = 49.2, total_amount = 2081160
 WHERE id = 800 AND unit_price IS NULL;  -- HYP-PO-202609-013 HYPMUBX044F050
UPDATE purchase_orders SET unit_price = 14.16, total_amount = 212400
 WHERE id = 801 AND unit_price IS NULL;  -- MCAFF-PO-202609-035 MCFMUBX0425F0050 — PARTIAL, 6 unrated line(s)
UPDATE purchase_orders SET unit_price = 69.98, total_amount = 909740
 WHERE id = 802 AND unit_price IS NULL;  -- MCAFF-PO-202609-036 MCaf375 — PARTIAL, 9 unrated line(s)
UPDATE purchase_orders SET unit_price = 44.86, total_amount = 982434
 WHERE id = 803 AND unit_price IS NULL;  -- MCAFF-PO-202609-037 MCaf382_WB — PARTIAL, 12 unrated line(s)
UPDATE purchase_orders SET unit_price = 31.13, total_amount = 859188
 WHERE id = 804 AND unit_price IS NULL;  -- HYP-PO-202609-014 HYPMUBX042F010
UPDATE purchase_orders SET unit_price = 86.37, total_amount = 690960
 WHERE id = 805 AND unit_price IS NULL;  -- MCAFF-PO-202609-038 MCaf385 — PARTIAL, 4 unrated line(s)
UPDATE purchase_orders SET unit_price = 80.45, total_amount = 1625090
 WHERE id = 807 AND unit_price IS NULL;  -- HYP-PO-202609-015 HYPMUBX044F100
UPDATE purchase_orders SET unit_price = 80.04, total_amount = 200100
 WHERE id = 808 AND unit_price IS NULL;  -- HYP-PO-202609-016 HYPMUBX045F020 — PARTIAL, 3 unrated line(s)
UPDATE purchase_orders SET unit_price = 63.82, total_amount = 1276400
 WHERE id = 809 AND unit_price IS NULL;  -- MCAFF-PO-202609-040 MCFMUBX0431F0050
UPDATE purchase_orders SET unit_price = 44.08, total_amount = 952128
 WHERE id = 810 AND unit_price IS NULL;  -- HYP-PO-202609-017 HYPMUBX032F050
UPDATE purchase_orders SET unit_price = 48.85, total_amount = 732750
 WHERE id = 811 AND unit_price IS NULL;  -- HYP-PO-202609-018 HYPMUBX010F100
UPDATE purchase_orders SET unit_price = 87.41, total_amount = 1066402
 WHERE id = 812 AND unit_price IS NULL;  -- HYP-PO-202609-019 HYPMUBX0058F0100
UPDATE purchase_orders SET unit_price = 22.25, total_amount = 445000
 WHERE id = 813 AND unit_price IS NULL;  -- MCAFF-PO-202609-041 MCaf302 — PARTIAL, 1 unrated line(s)
UPDATE purchase_orders SET unit_price = 88.11, total_amount = 2766654
 WHERE id = 814 AND unit_price IS NULL;  -- MCAFF-PO-202609-042 MCaf40 — PARTIAL, 1 unrated line(s)
UPDATE purchase_orders SET unit_price = 46.91, total_amount = 919436
 WHERE id = 816 AND unit_price IS NULL;  -- MCAFF-PO-202609-044 MCaf209_WB — PARTIAL, 1 unrated line(s)
UPDATE purchase_orders SET unit_price = 44.46, total_amount = 666900
 WHERE id = 817 AND unit_price IS NULL;  -- MCAFF-PO-202609-045 Mcaf405 — PARTIAL, 4 unrated line(s)
UPDATE purchase_orders SET unit_price = 57.84, total_amount = 867600
 WHERE id = 819 AND unit_price IS NULL;  -- MCAFF-PO-202609-047 MCaf280_WB
UPDATE purchase_orders SET unit_price = 31.64, total_amount = 791000
 WHERE id = 820 AND unit_price IS NULL;  -- HYP-PO-202609-020 HYPMUBX041F010
UPDATE purchase_orders SET unit_price = 62.56, total_amount = 416024
 WHERE id = 821 AND unit_price IS NULL;  -- FEIN-PO-202609-001 MGKIT64_SWM_S_N1
UPDATE purchase_orders SET unit_price = 60.05, total_amount = 1201000
 WHERE id = 822 AND unit_price IS NULL;  -- HYP-PO-202609-021 HYPMUBX020F030 — PARTIAL, 1 unrated line(s)
UPDATE purchase_orders SET unit_price = 44.22, total_amount = 884400
 WHERE id = 823 AND unit_price IS NULL;  -- HYP-PO-202609-022 HYPMUBX005F010
UPDATE purchase_orders SET unit_price = 38.16, total_amount = 370152
 WHERE id = 824 AND unit_price IS NULL;  -- MCAFF-PO-202609-048 MCaf270
UPDATE purchase_orders SET unit_price = 39.15, total_amount = 505035
 WHERE id = 825 AND unit_price IS NULL;  -- HYP-PO-202609-023 HYPMUBX012F100
UPDATE purchase_orders SET unit_price = 47.39, total_amount = 236950
 WHERE id = 826 AND unit_price IS NULL;  -- MCAFF-PO-202609-049 MCaf285_WB — PARTIAL, 11 unrated line(s)
UPDATE purchase_orders SET unit_price = 39.87, total_amount = 259155
 WHERE id = 829 AND unit_price IS NULL;  -- HYP-PO-202609-024 HYPMUBX011F100
UPDATE purchase_orders SET unit_price = 17.99, total_amount = 179900
 WHERE id = 830 AND unit_price IS NULL;  -- HYP-PO-202609-025 HYPMUBX024F010 — PARTIAL, 17 unrated line(s)
UPDATE purchase_orders SET unit_price = 28.32, total_amount = 283200
 WHERE id = 831 AND unit_price IS NULL;  -- MCAFF-PO-202609-052 MCaf220 — PARTIAL, 7 unrated line(s)
UPDATE purchase_orders SET unit_price = 97.05, total_amount = 456135
 WHERE id = 832 AND unit_price IS NULL;  -- MCAFF-PO-202609-053 MCaf259
UPDATE purchase_orders SET unit_price = 121.66, total_amount = 243320
 WHERE id = 834 AND unit_price IS NULL;  -- MCAFF-PO-202609-055 MCaf48
UPDATE purchase_orders SET unit_price = 86, total_amount = 860000
 WHERE id = 835 AND unit_price IS NULL;  -- HYP-PO-202609-026 HYPMUBX030F050
UPDATE purchase_orders SET unit_price = 60.36, total_amount = 790716
 WHERE id = 836 AND unit_price IS NULL;  -- MCAFF-PO-202609-056 MCFMUBX0427F0050
UPDATE purchase_orders SET unit_price = 56.54, total_amount = 282700
 WHERE id = 837 AND unit_price IS NULL;  -- FEIN-PO-202609-002 MGKIT65_RUSH_S_N1
UPDATE purchase_orders SET unit_price = 37.39, total_amount = 594314.05
 WHERE id = 838 AND unit_price IS NULL;  -- HYP-PO-202609-027 HYPMUBX028F050 — PARTIAL, 1 unrated line(s)
UPDATE purchase_orders SET unit_price = 69.33, total_amount = 346650
 WHERE id = 839 AND unit_price IS NULL;  -- FEIN-PO-202609-003 MCFMUBX0419F0050 — PARTIAL, 1 unrated line(s)
UPDATE purchase_orders SET unit_price = 26.19, total_amount = 130950
 WHERE id = 840 AND unit_price IS NULL;  -- MCAFF-PO-202609-057 200MCaf401_WB — PARTIAL, 5 unrated line(s)
UPDATE purchase_orders SET unit_price = 71.38, total_amount = 1518538.12
 WHERE id = 841 AND unit_price IS NULL;  -- HYP-PO-202609-028 HYPMUBX013F030
UPDATE purchase_orders SET unit_price = 76.11, total_amount = 1430868
 WHERE id = 842 AND unit_price IS NULL;  -- HYP-PO-202609-029 HYPMUBX008F050
UPDATE purchase_orders SET unit_price = 58.69, total_amount = 704280
 WHERE id = 843 AND unit_price IS NULL;  -- MCAFF-PO-202609-058 100MCaf48
UPDATE purchase_orders SET unit_price = 41.59, total_amount = 145565
 WHERE id = 844 AND unit_price IS NULL;  -- MCAFF-PO-202609-059 MCaf208_WB — PARTIAL, 1 unrated line(s)
UPDATE purchase_orders SET unit_price = 33.11, total_amount = 208593
 WHERE id = 845 AND unit_price IS NULL;  -- MCAFF-PO-202609-060 MCaf83_N
UPDATE purchase_orders SET unit_price = 40.79, total_amount = 81580
 WHERE id = 846 AND unit_price IS NULL;  -- MCAFF-PO-202609-061 150MCaf370_WB
UPDATE purchase_orders SET unit_price = 32.7, total_amount = 21255
 WHERE id = 849 AND unit_price IS NULL;  -- MCAFF-PO-202609-064 MCFGKIT0087F0007_S — PARTIAL, 2 unrated line(s)
UPDATE purchase_orders SET unit_price = 30.28, total_amount = 370930
 WHERE id = 850 AND unit_price IS NULL;  -- MCAFF-PO-202609-065 MCaf369 — PARTIAL, 7 unrated line(s)
UPDATE purchase_orders SET unit_price = 137.07, total_amount = 342675
 WHERE id = 851 AND unit_price IS NULL;  -- FEIN-PO-202609-004 MCaf352
UPDATE purchase_orders SET unit_price = 86.57, total_amount = 865700
 WHERE id = 852 AND unit_price IS NULL;  -- HYP-PO-202609-030 HYPMUBX043F050 — PARTIAL, 7 unrated line(s)
UPDATE purchase_orders SET unit_price = 82.72, total_amount = 372240
 WHERE id = 857 AND unit_price IS NULL;  -- HYP-PO-202609-031 HYPMUBX015F030
UPDATE purchase_orders SET unit_price = 33.11, total_amount = 165550
 WHERE id = 858 AND unit_price IS NULL;  -- MCAFF-PO-202609-070 MCaf221_N
UPDATE purchase_orders SET unit_price = 8.71, total_amount = 130650
 WHERE id = 859 AND unit_price IS NULL;  -- MCAFF-PO-202609-071 25SMCaf212
UPDATE purchase_orders SET unit_price = 108.15, total_amount = 540750
 WHERE id = 860 AND unit_price IS NULL;  -- HYP-PO-202609-032 HYPMUBX031F018
UPDATE purchase_orders SET unit_price = 11.09, total_amount = 554500
 WHERE id = 861 AND unit_price IS NULL;  -- MCAFF-PO-202609-072 15SMCaf42_N1
UPDATE purchase_orders SET unit_price = 36.53, total_amount = 306852
 WHERE id = 862 AND unit_price IS NULL;  -- MCAFF-PO-202609-073 MCaf42_WB
UPDATE purchase_orders SET unit_price = 73.25, total_amount = 820253.5
 WHERE id = 863 AND unit_price IS NULL;  -- HYP-PO-202609-033 HYPMUBX016F030
UPDATE purchase_orders SET unit_price = 17.99, total_amount = 359800
 WHERE id = 864 AND unit_price IS NULL;  -- HYP-PO-202609-034 HYPMUBX023F010 — PARTIAL, 16 unrated line(s)
UPDATE purchase_orders SET unit_price = 84.93, total_amount = 1273950
 WHERE id = 865 AND unit_price IS NULL;  -- HYP-PO-202609-035 HYPMUBX002F050
UPDATE purchase_orders SET unit_price = 72.69, total_amount = 3314664
 WHERE id = 866 AND unit_price IS NULL;  -- HYP-PO-202609-036 HYPMUBX003F030
UPDATE purchase_orders SET unit_price = 60.67, total_amount = 121340
 WHERE id = 867 AND unit_price IS NULL;  -- MCAFF-PO-202609-074 MCaf234_WB
UPDATE purchase_orders SET unit_price = 78.38, total_amount = 568803.66
 WHERE id = 869 AND unit_price IS NULL;  -- HYP-PO-202609-038 HYPMUBX004F050 — PARTIAL, 6 unrated line(s)
UPDATE purchase_orders SET unit_price = 18.18, total_amount = 411577.02
 WHERE id = 870 AND unit_price IS NULL;  -- MCAFF-PO-202609-075 MCFMUWB0401F0080 — PARTIAL, 5 unrated line(s)
UPDATE purchase_orders SET unit_price = 30.48, total_amount = 1056741.6
 WHERE id = 871 AND unit_price IS NULL;  -- MCAFF-PO-202609-076 MCFMUBX0423F0275 — PARTIAL, 12 unrated line(s)
UPDATE purchase_orders SET unit_price = 14.52, total_amount = 416186.76
 WHERE id = 872 AND unit_price IS NULL;  -- MCAFF-PO-202609-077 MCFMUBX0422F0250 — PARTIAL, 20 unrated line(s)
UPDATE purchase_orders SET unit_price = 14.52, total_amount = 216435.12
 WHERE id = 873 AND unit_price IS NULL;  -- MCAFF-PO-202609-078 MCFMUBX0421F0250 — PARTIAL, 18 unrated line(s)
UPDATE purchase_orders SET unit_price = 30.49, total_amount = 304900
 WHERE id = 874 AND unit_price IS NULL;  -- MCAFF-PO-202609-079 MCFMUBX0424F0275 — PARTIAL, 11 unrated line(s)
