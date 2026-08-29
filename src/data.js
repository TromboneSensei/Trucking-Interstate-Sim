// data.js
// V16.5 - Supreme Freight Architect Pass (187+ Nodes, Chokes & Triangles)

export const masterCities = {
    // --- GULF COAST ---
    "Houston": { t: 1, w: 10.0, lat: 29.7604, lon: -95.3698, ind: ["Energy", "Space", "Port", "Refinery"] },
    "Baton Rouge": { t: 2, w: 6.0, lat: 30.4515, lon: -91.1871, ind: ["Petrochem", "Refinery"] },
    "New Orleans": { t: 1, w: 8.5, lat: 29.9511, lon: -90.0715, ind: ["Port", "Seafood"] },
    "Lake Charles": { t: 4, w: 3.5, lat: 30.2266, lon: -93.2174, ind: ["Petrochem", "Refinery"] },
    "Lafayette": { t: 3, w: 3.5, lat: 30.2241, lon: -92.0198, ind: ["Energy", "Culture"] },
    "Midland": { t: 3, w: 7.0, lat: 31.9973, lon: -102.0779, ind: ["Oil", "Source"] },
    "Odessa": { t: 3, w: 6, lat: 31.8457, lon: -102.3676, ind: ["Oil", "Logistics"] },
    "Corpus Christi": { t: 3, w: 5.5, lat: 27.8006, lon: -97.3964, ind: ["Port", "Energy"] },
    "Laplace": { t: 0, w: 1.0, lat: 30.0666, lon: -90.4801, ind: ["Junction"] }, 
    "Beaumont": { t: 3, w: 5.0, lat: 30.0802, lon: -94.1266, ind: ["Refinery", "Port"] }, 
    "Brownsville": { t: 3, w: 4.5, lat: 25.9017, lon: -97.4975, ind: ["Space", "Port"] }, 
    "Fort Stockton": { t: 3, w: 3.5, lat: 30.8940, lon: -102.8793, ind: ["Oil", "Junction", "Fuel"] }, // V16.5 Survival Node
    "Kerrville": { t: 0, w: 1.0, lat: 30.0455, lon: -99.1403, ind: ["Junction"] }, // V16.5 
    "Victoria": { t: 4, w: 2.5, lat: 28.8053, lon: -97.0036, ind: ["Logistics", "Petrochem"] }, // V16.5 NAFTA Triangle
    "San Angelo": { t: 4, w: 2.0, lat: 31.4638, lon: -100.4370, ind: ["Ag", "Oil"] }, // V16.5 

    // --- WEST COAST ---
    "Los Angeles": { t: 1, w: 10.0, lat: 34.0522, lon: -118.2437, ind: ["Port", "Tech", "Media"] },
    "San Diego": { t: 1, w: 7.5, lat: 32.7157, lon: -117.1611, ind: ["Defense", "Biotech"] },
    "San Francisco": { t: 1, w: 8.0, lat: 37.7749, lon: -122.4194, ind: ["Tech", "Finance"] },
    "Oakland": { t: 2, w: 7.0, lat: 37.8044, lon: -122.2711, ind: ["Port", "Logistics"] }, 
    "San Jose": { t: 2, w: 7.0, lat: 37.3382, lon: -121.8863, ind: ["Tech"] },
    "Seattle": { t: 1, w: 8.0, lat: 47.6062, lon: -122.3321, ind: ["Tech", "Aerospace"] },
    "Tacoma": { t: 2, w: 6.5, lat: 47.2529, lon: -122.4443, ind: ["Port", "Logistics"] }, 
    "Portland": { t: 1, w: 7.5, lat: 45.5152, lon: -122.6784, ind: ["Sportswear", "Shipping"] },
    "Sacramento": { t: 2, w: 6.0, lat: 38.5816, lon: -121.4944, ind: ["Govt", "Ag"] },
    "Fresno": { t: 2, w: 6.0, lat: 36.7378, lon: -119.7871, ind: ["Ag", "Produce"] }, 
    "Visalia": { t: 3, w: 4.0, lat: 36.3302, lon: -119.2921, ind: ["Ag", "Dairy"] }, 
    "Bakersfield": { t: 3, w: 5.0, lat: 35.3733, lon: -119.0187, ind: ["Oil", "Ag"] },
    "San Bernardino": { t: 2, w: 6.5, lat: 34.1083, lon: -117.2898, ind: ["Logistics", "Inland Empire", "Dry Van"] },
    "Riverside": { t: 2, w: 6.5, lat: 33.9533, lon: -117.3961, ind: ["Logistics", "Citrus"] }, 
    "Long Beach": { t: 2, w: 7.0, lat: 33.7701, lon: -118.1937, ind: ["Port", "Oil"] }, 
    "Stockton": { t: 3, w: 4.5, lat: 37.9577, lon: -121.2908, ind: ["Port", "Ag"] },
    "Modesto": { t: 3, w: 4.0, lat: 37.6391, lon: -120.9969, ind: ["Ag", "Wine"] },
    "Santa Monica": { t: 4, w: 2.5, lat: 34.0195, lon: -118.4912, ind: ["Tourism"] },
    "Santa Barbara": { t: 4, w: 2.5, lat: 34.4208, lon: -119.6982, ind: ["Tourism", "Tech"] },
    "San Luis Obispo": { t: 4, w: 2.0, lat: 35.2828, lon: -120.6596, ind: ["Edu", "Ag"] },
    "Santa Rosa": { t: 3, w: 4.0, lat: 38.4404, lon: -122.7140, ind: ["Wine", "Ag"] }, 
    "Redding": { t: 4, w: 2.0, lat: 40.5865, lon: -122.3917, ind: ["Timber"] },
    "Medford": { t: 4, w: 2.0, lat: 42.3265, lon: -122.8756, ind: ["Fruit"] },
    "Eugene": { t: 3, w: 3.5, lat: 44.0521, lon: -123.0868, ind: ["Edu", "Timber"] },
    "Salem": { t: 3, w: 4.0, lat: 44.9429, lon: -123.0351, ind: ["Ag", "Govt"] }, 
    "Bend": { t: 4, w: 3.5, lat: 44.0582, lon: -121.3153, ind: ["Brewing", "Tourism"] }, 
    "The Dalles": { t: 4, w: 1.0, lat: 45.5946, lon: -121.1787, ind: ["Hydro", "Ag"] },
    "Pendleton": { t: 4, w: 1.0, lat: 45.6721, lon: -118.7886, ind: ["Wool", "Rodeo"] },
    "Blaine": { t: 4, w: 1.5, lat: 48.9937, lon: -122.7484, ind: ["Customs"] },
    "Spokane": { t: 3, w: 4.0, lat: 47.6588, lon: -117.4260, ind: ["Healthcare"] },
    "Ellensburg": { t: 4, w: 1.5, lat: 46.9965, lon: -120.5478, ind: ["Hay", "Wind"] },
    "Yakima": { t: 4, w: 2.5, lat: 46.6021, lon: -120.5059, ind: ["Ag", "Produce"] },
    "Kennewick": { t: 4, w: 2.5, lat: 46.2112, lon: -119.1372, ind: ["Energy", "Wine"] },
    "Hermiston": { t: 4, w: 1.5, lat: 45.8404, lon: -119.2895, ind: ["Ag", "Logistics"] },
    "Olympia": { t: 4, w: 3.0, lat: 47.0379, lon: -122.9007, ind: ["Govt", "Timber"] }, 
    "Everett": { t: 4, w: 3.0, lat: 47.9780, lon: -122.2021, ind: ["Aerospace"] }, 
    "Coeur dAlene": { t: 4, w: 2.0, lat: 47.6777, lon: -116.7805, ind: ["Tourism", "Mining"] },
    "Mettler": { t: 0, w: 0.5, lat: 35.0633, lon: -118.9711, ind: ["Junction"] },
    "Gilroy": { t: 0, w: 1.0, lat: 37.0058, lon: -121.5683, ind: ["Junction"] },
    "Monterey": { t: 3, w: 3.5, lat: 36.6002, lon: -121.8947, ind: ["Tourism", "Ag"] },
    "Eureka": { t: 4, w: 1.5, lat: 40.8021, lon: -124.1637, ind: ["Timber", "Port"] },
    "Tehachapi": { t: 0, w: 0.5, lat: 35.1322, lon: -118.4490, ind: ["Junction", "Mountain Pass"] }, // V16.5 Invisible Choke

    // --- MOUNTAIN ---
    "Phoenix": { t: 1, w: 8.0, lat: 33.4484, lon: -112.0740, ind: ["Chips", "Aero"] },
    "Las Vegas": { t: 1, w: 7.0, lat: 36.1699, lon: -115.1398, ind: ["Gaming", "Logistics"] },
    "Salt Lake City": { t: 1, w: 7.0, lat: 40.7608, lon: -111.8910, ind: ["Mining", "Refinery"] },
    "Ogden": { t: 3, w: 4.0, lat: 41.2230, lon: -111.9738, ind: ["Rail", "Logistics"] }, 
    "Provo": { t: 3, w: 4.0, lat: 40.2338, lon: -111.6585, ind: ["Tech", "Edu"] }, 
    "Denver": { t: 1, w: 8.0, lat: 39.7392, lon: -104.9903, ind: ["Aerospace", "Telecom"] },
    "Fort Collins": { t: 3, w: 4.5, lat: 40.5853, lon: -105.0844, ind: ["Brewing", "Tech"] }, 
    "Boise": { t: 3, w: 5.0, lat: 43.6150, lon: -116.2023, ind: ["Tech", "Ag"] },
    "Idaho Falls": { t: 3, w: 3.0, lat: 43.4927, lon: -112.0408, ind: ["Research", "Ag"] }, 
    "Tucson": { t: 2, w: 5.5, lat: 32.2226, lon: -110.9747, ind: ["Missiles", "Mining"] },
    "Colorado Springs": { t: 2, w: 5.0, lat: 38.8339, lon: -104.8214, ind: ["Military", "Space"] },
    "Albuquerque": { t: 2, w: 5.5, lat: 35.0844, lon: -106.6504, ind: ["Energy", "Film"] },
    "Reno": { t: 3, w: 5.5, lat: 39.5296, lon: -119.8138, ind: ["Tesla", "Gaming"] },
    "Twin Falls": { t: 4, w: 2.0, lat: 42.5628, lon: -114.4609, ind: ["Ag", "Food Proc"] },
    "Yuma": { t: 4, w: 2.5, lat: 32.6926, lon: -114.6277, ind: ["Ag", "Military"] },
    "Casa Grande": { t: 3, w: 1.5, lat: 32.8795, lon: -111.7573, ind: ["Junction"] },
    "Flagstaff": { t: 4, w: 2.0, lat: 35.1983, lon: -111.6513, ind: ["Gore-Tex"] },
    "Nogales": { t: 4, w: 1.5, lat: 31.3404, lon: -110.9343, ind: ["Border", "Produce"] },
    "St. George": { t: 4, w: 2.5, lat: 37.0965, lon: -113.5684, ind: ["Distribution"] },
    "Pocatello": { t: 4, w: 2.0, lat: 42.8666, lon: -112.4506, ind: ["Chips", "Rail"] },
    "Butte": { t: 4, w: 2.0, lat: 46.0038, lon: -112.5347, ind: ["Mining"] },
    "Helena": { t: 4, w: 2.0, lat: 46.5891, lon: -112.0391, ind: ["Govt"] },
    "Great Falls": { t: 4, w: 2.0, lat: 47.5053, lon: -111.3008, ind: ["Ag", "Military"] },
    "Missoula": { t: 4, w: 2.0, lat: 46.8721, lon: -113.9940, ind: ["Timber"] },
    "Bozeman": { t: 4, w: 2.5, lat: 45.6770, lon: -111.0429, ind: ["Tech", "Tourism"] },
    "Billings": { t: 3, w: 3.0, lat: 45.7833, lon: -108.5007, ind: ["Refining", "Livestock"] },
    "Miles City": { t: 4, w: 1.0, lat: 46.4083, lon: -105.8406, ind: ["Livestock"] },
    "Gillette": { t: 4, w: 3.0, lat: 44.2911, lon: -105.5022, ind: ["Coal", "Energy"] }, 
    "Casper": { t: 3, w: 3.0, lat: 42.8666, lon: -106.3131, ind: ["Energy", "Medical"] },
    "Cheyenne": { t: 3, w: 3.0, lat: 41.1400, lon: -104.8202, ind: ["Railroad", "Data"] },
    "Santa Fe": { t: 4, w: 2.0, lat: 35.6869, lon: -105.9378, ind: ["Govt", "Arts"] },
    "Pueblo": { t: 4, w: 2.5, lat: 38.2542, lon: -104.6091, ind: ["Steel", "Wind"] },
    "Las Cruces": { t: 4, w: 2.5, lat: 32.3199, lon: -106.7637, ind: ["Ag", "Space"] },
    "Elko": { t: 4, w: 1.5, lat: 40.8324, lon: -115.7631, ind: ["Gold Mining"] },
    "Barstow": { t: 4, w: 1.5, lat: 34.8958, lon: -117.0173, ind: ["Rail", "Military"] },
    "Kingman": { t: 4, w: 1.5, lat: 35.1894, lon: -114.0530, ind: ["Distribution"] },
    "Grand Junction": { t: 4, w: 2.0, lat: 39.0639, lon: -108.5506, ind: ["Oil Shale"] },
    "Montrose": { t: 4, w: 2.0, lat: 38.4783, lon: -107.8762, ind: ["Mining"] }, 
    "Price": { t: 4, w: 2.0, lat: 39.5994, lon: -110.8107, ind: ["Mining", "Energy"] }, 
    
    // --- Strategic Towns & Desert Corridors ---
    "Limon": { t: 0, w: 1.0, lat: 39.2639, lon: -103.6922, ind: ["Junction"] }, 
    "Sterling": { t: 4, w: 1.5, lat: 40.6255, lon: -103.2077, ind: ["Ag", "Prison"] }, 
    "Winnemucca": { t: 4, w: 1.0, lat: 40.9730, lon: -117.7357, ind: ["Mining"] },
    "Rawlins": { t: 4, w: 1.0, lat: 41.7911, lon: -107.2387, ind: ["Wind", "Refining"] },
    "Rock Springs": { t: 4, w: 1.5, lat: 41.5875, lon: -109.2029, ind: ["Coal", "Energy"] },
    "Sweetgrass": { t: 4, w: 0.8, lat: 48.9961, lon: -111.9567, ind: ["Border", "Wheat"] },
    "Tremonton": { t: 0, w: 0.5, lat: 41.7119, lon: -112.1655, ind: ["Junction"] },
    "Cove Fort": { t: 0, w: 0.5, lat: 38.5990, lon: -112.5800, ind: ["Junction"] },
    "Wells": { t: 0, w: 0.5, lat: 41.1107, lon: -114.9669, ind: ["Junction"] },
    "Heyburn": { t: 0, w: 0.5, lat: 42.5558, lon: -113.7656, ind: ["Junction"] },
    "Madras": { t: 0, w: 1.0, lat: 44.6335, lon: -121.1295, ind: ["Junction"] }, 
    "Delta UT": { t: 0, w: 1.0, lat: 39.3522, lon: -112.5772, ind: ["Junction"] }, 
    "South Lake Tahoe": { t: 4, w: 2.0, lat: 38.9399, lon: -119.9772, ind: ["Tourism"] }, 
    "Carson City": { t: 4, w: 2.0, lat: 39.1638, lon: -119.7674, ind: ["Govt"] }, 
    "Fallon": { t: 4, w: 1.5, lat: 39.4735, lon: -118.7774, ind: ["Ag", "Military"] }, 
    "Ely": { t: 4, w: 1.5, lat: 39.2474, lon: -114.8886, ind: ["Mining"] }, 
    "Burns": { t: 4, w: 1.0, lat: 43.5863, lon: -119.0544, ind: ["Ranching"] }, 
    "Jackson Hole": { t: 4, w: 2.5, lat: 43.4799, lon: -110.7624, ind: ["Tourism", "Wealth"] }, 
    "Susanville": { t: 4, w: 1.5, lat: 40.4163, lon: -120.6530, ind: ["Prison", "Timber"] }, 
    "Gallup": { t: 3, w: 3.5, lat: 35.5281, lon: -108.7426, ind: ["Rail", "Logistics", "Fuel"] }, // V16.5 Survival Node
    "Tucumcari": { t: 4, w: 1.5, lat: 35.1717, lon: -103.7250, ind: ["Trucking", "Route 66", "Fuel"] }, // V16.5 Survival Node
    "Battle Mountain": { t: 0, w: 1.0, lat: 40.6405, lon: -116.9388, ind: ["Junction", "Fuel"] }, // V16.5 Survival Node
    "Quartzsite": { t: 0, w: 0.5, lat: 33.6644, lon: -114.2289, ind: ["Junction", "Fuel"] }, // V16.5 Invisible Choke
    "Silverthorne": { t: 0, w: 0.5, lat: 39.6296, lon: -106.0713, ind: ["Junction", "Mountain Pass"] }, // V16.5 Invisible Choke
    "Laramie": { t: 0, w: 0.5, lat: 41.3114, lon: -105.5911, ind: ["Junction", "Fuel"] }, // V16.5 Invisible Choke
    "Buffalo WY": { t: 4, w: 1.0, lat: 44.3483, lon: -106.6989, ind: ["Tourism"] }, // Standardized name
    // --- PLAINS / CENTRAL ---
    "Dallas": { t: 1, w: 9.0, lat: 32.7767, lon: -96.7970, ind: ["Finance", "Telecom"] },
    "Denton": { t: 4, w: 2.2, lat: 33.2148, lon: -97.1331, ind: ["Logistics", "Education"] },
    "San Antonio": { t: 1, w: 8.0, lat: 29.4241, lon: -98.4936, ind: ["Military", "Tourism"] },
    "Kansas City": { t: 1, w: 8.0, lat: 39.0997, lon: -94.5786, ind: ["Auto", "Rail"] },
    "Minneapolis": { t: 1, w: 7.5, lat: 44.9778, lon: -93.2650, ind: ["Retail HQ", "Medical"] },
    "Fort Worth": { t: 2, w: 7.0, lat: 32.7555, lon: -97.3308, ind: ["Aviation", "Cattle"] },
    "Oklahoma City": { t: 2, w: 6.0, lat: 35.4676, lon: -97.5164, ind: ["Energy", "Aviation"] },
    "Austin": { t: 2, w: 6.5, lat: 30.2672, lon: -97.7431, ind: ["Tech", "Govt"] },
    "Wichita": { t: 3, w: 4.5, lat: 37.6872, lon: -97.3301, ind: ["Aviation Mfg", "Ag"] },
    "Tulsa": { t: 2, w: 5.5, lat: 36.1540, lon: -95.9928, ind: ["Aero", "Energy"] },
    "Omaha": { t: 2, w: 5.5, lat: 41.2565, lon: -95.9345, ind: ["Finance", "Food"] },
    "Des Moines": { t: 3, w: 4.0, lat: 41.5868, lon: -93.6250, ind: ["Insurance", "Ag-Tech"] },
    "Little Rock": { t: 3, w: 4.0, lat: 34.7465, lon: -92.2896, ind: ["Govt", "Aero"] },
    "Fargo": { t: 3, w: 3.5, lat: 46.8772, lon: -96.7898, ind: ["Tech", "Ag"] },
    "El Paso": { t: 2, w: 6.0, lat: 31.7619, lon: -106.4850, ind: ["Border", "Refining"] },
    "Laredo": { t: 2, w: 8.5, lat: 27.5306, lon: -99.4803, ind: ["Border", "NAFTA", "Customs", "Freight"] },
    "Galveston": { t: 4, w: 2.5, lat: 29.3013, lon: -94.7977, ind: ["Port", "Medical"] },
    "McAllen": { t: 3, w: 3.5, lat: 26.2034, lon: -98.2300, ind: ["Border", "Citrus"] },
    "Lubbock": { t: 3, w: 4.0, lat: 33.5779, lon: -101.8552, ind: ["Ag", "Cotton"] },
    "Amarillo": { t: 3, w: 4.0, lat: 35.2220, lon: -101.8313, ind: ["Meat Packing"] },
    "Abilene": { t: 3, w: 3.0, lat: 32.4487, lon: -99.7331, ind: ["AFB", "Wind"] },
    "Waco": { t: 3, w: 3.5, lat: 31.5493, lon: -97.1467, ind: ["Edu", "Tourism"] },
    "Killeen": { t: 4, w: 2.5, lat: 31.1171, lon: -97.7278, ind: ["Military", "Armor"] },
    "Texarkana": { t: 4, w: 2.5, lat: 33.4251, lon: -94.0477, ind: ["Paper", "Military"] },
    "Fayetteville AR": { t: 3, w: 3.0, lat: 36.0626, lon: -94.1574, ind: ["Retail HQ", "Edu"] },
    "Fort Smith": { t: 3, w: 2.5, lat: 35.3859, lon: -94.3985, ind: ["Mfg", "Trucking"] },
    "Springfield MO": { t: 3, w: 3.5, lat: 37.2089, lon: -93.2923, ind: ["Trucking HQ"] },
    "Topeka": { t: 3, w: 3.0, lat: 39.0473, lon: -95.6752, ind: ["Govt", "Rail"] },
    "Lincoln": { t: 3, w: 4.0, lat: 40.8136, lon: -96.7026, ind: ["Govt", "Insurance"] },
    "Sioux Falls": { t: 3, w: 3.5, lat: 43.5460, lon: -96.7313, ind: ["Banking"] },
    "Rapid City": { t: 3, w: 3.0, lat: 44.0805, lon: -103.2310, ind: ["Tourism", "AFB"] },
    "Bismarck": { t: 3, w: 3.0, lat: 46.8083, lon: -100.7837, ind: ["Energy", "Govt"] },
    "Dickinson": { t: 4, w: 2.5, lat: 46.8792, lon: -102.7896, ind: ["Oil"] }, 
    "Williston": { t: 3, w: 3.5, lat: 48.1470, lon: -103.6180, ind: ["Oil", "Fracking"] }, 
    "Minot": { t: 3, w: 2.5, lat: 48.2330, lon: -101.2923, ind: ["AFB", "Energy"] }, 
    "Boise City": { t: 4, w: 0.8, lat: 36.7295, lon: -102.5132, ind: ["Junction", "Ag"] },
    "Big Springs": { t: 4, w: 1.0, lat: 41.1300, lon: -102.0463, ind: ["Junction", "Ag"] },
    "North Platte": { t: 4, w: 1.5, lat: 41.1239, lon: -100.7654, ind: ["Rail Yard", "Ag"] },
    "Scottsbluff": { t: 4, w: 2.0, lat: 41.8666, lon: -103.6672, ind: ["Ag"] }, 
    "Kearney": { t: 4, w: 1.5, lat: 40.6995, lon: -99.0815, ind: ["Edu", "Ag"] },
    "Salina": { t: 4, w: 2.0, lat: 38.8403, lon: -97.6114, ind: ["Junction", "Wheat"] },
    "Joplin": { t: 4, w: 2.0, lat: 37.0842, lon: -94.5133, ind: ["Trucking", "Mining"] },
    "Columbia MO": { t: 3, w: 2.5, lat: 38.9517, lon: -92.3341, ind: ["Edu", "Insurance"] },
    "Sioux City": { t: 4, w: 2.5, lat: 42.4999, lon: -96.4003, ind: ["Food Proc"] },
    "Cedar Rapids": { t: 3, w: 4.0, lat: 41.9779, lon: -91.6656, ind: ["Ag", "Processing"] }, 
    "Dubuque": { t: 4, w: 2.0, lat: 42.5005, lon: -90.6645, ind: ["River Logistics"] }, 
    "Temple": { t: 0, w: 1.0, lat: 31.0982, lon: -97.3428, ind: ["Junction"] },
    "Van Horn": { t: 4, w: 1.0, lat: 31.0396, lon: -104.8308, ind: ["Space Tourism"] },
    "Scroggins Draw": { t: 0, w: 0.5, lat: 31.0500, lon: -104.1000, ind: ["Junction"] },
    "Rolla": { t: 4, w: 1.5, lat: 37.9485, lon: -91.7715, ind: ["Edu", "Science"] },
    "Grand Forks": { t: 4, w: 2.0, lat: 47.9253, lon: -97.0329, ind: ["Aero", "Defense"] },
    "Pembina": { t: 4, w: 0.8, lat: 48.9667, lon: -97.2406, ind: ["Border"] },
    "St. Joseph": { t: 4, w: 2.0, lat: 39.7675, lon: -94.8467, ind: ["Ag", "Bio-science"] },
    "Lawton": { t: 4, w: 2.0, lat: 34.6036, lon: -98.3959, ind: ["Military", "Tires"] },
    "Wichita Falls": { t: 4, w: 2.5, lat: 33.9137, lon: -98.4934, ind: ["AFB", "Energy"] },
    "Hays": { t: 4, w: 1.5, lat: 38.8792, lon: -99.3223, ind: ["Ag", "Oil"] },
    "Pine Bluff": { t: 4, w: 1.5, lat: 34.2284, lon: -92.0032, ind: ["Paper", "Arsenal"] },
    "Alexandria": { t: 4, w: 2.0, lat: 31.3113, lon: -92.4451, ind: ["Forestry", "Military"] },
    "Colby": { t: 4, w: 1.5, lat: 39.3958, lon: -101.0522, ind: ["Ag", "Junction", "Fuel"] }, // V16.5 Survival Node
    "Mitchell": { t: 4, w: 2.0, lat: 43.7091, lon: -98.0298, ind: ["Ag", "Corn", "Fuel"] }, // V16.5 Survival Node
    "Council Bluffs": { t: 4, w: 2.2, lat: 41.2619, lon: -95.8608, ind: ["Rail", "Logistics"] }, // V16.5 Economy (Safely Weighted)

    // --- MIDWEST / LAKES ---
    "Chicago": { t: 1, w: 9.5, lat: 41.8781, lon: -87.6298, ind: ["Finance", "Transport", "Mfg"] },
    "Detroit": { t: 1, w: 7.5, lat: 42.3314, lon: -83.0458, ind: ["Automotive", "Auto"] },
    "St. Louis": { t: 1, w: 7.5, lat: 38.6270, lon: -90.1994, ind: ["Bio-science", "Beer"] },
    "Indianapolis": { t: 2, w: 7.0, lat: 39.7684, lon: -86.1581, ind: ["Pharma", "Racing", "Mfg"] },
    "Cleveland": { t: 2, w: 5.5, lat: 41.4993, lon: -81.6944, ind: ["Medical", "Steel"] },
    "Columbus": { t: 2, w: 6.0, lat: 39.9612, lon: -82.9988, ind: ["Retail HQ", "Research"] },
    "Cincinnati": { t: 2, w: 5.5, lat: 39.1031, lon: -84.5120, ind: ["Consumer Goods", "Aero"] },
    "Milwaukee": { t: 2, w: 5.5, lat: 43.0389, lon: -87.9065, ind: ["Brewing", "Mfg"] },
    "Louisville": { t: 2, w: 6.0, lat: 38.2527, lon: -85.7585, ind: ["UPS Hub", "Bourbon"] },
    "Toledo": { t: 3, w: 4.0, lat: 41.6528, lon: -83.5379, ind: ["Jeep", "Glass", "Auto"] },
    "Grand Rapids": { t: 3, w: 4.0, lat: 42.9634, lon: -85.6681, ind: ["Furniture", "Healthcare"] },
    "Madison": { t: 3, w: 4.0, lat: 43.0731, lon: -89.4012, ind: ["Software", "Biotech"] },
    "Rockford": { t: 3, w: 4.5, lat: 42.2711, lon: -89.0940, ind: ["Mfg", "Logistics"] }, 
    "Peoria": { t: 3, w: 3.5, lat: 40.6936, lon: -89.5890, ind: ["Heavy Machinery", "Ag"] },
    "Davenport": { t: 3, w: 3.0, lat: 41.5236, lon: -90.5776, ind: ["Machinery", "Arsenal"] },
    "Lansing": { t: 4, w: 3.0, lat: 42.7325, lon: -84.5555, ind: ["Govt", "Auto"] },
    "Akron": { t: 4, w: 3.0, lat: 41.0814, lon: -81.5190, ind: ["Polymers", "Tires"] },
    "Green Bay": { t: 3, w: 3.0, lat: 44.5133, lon: -88.0133, ind: ["Paper", "Football"] },
    "Fort Wayne": { t: 3, w: 4.0, lat: 41.0793, lon: -85.1394, ind: ["Mfg", "Logistics"] },
    "Evansville": { t: 3, w: 3.0, lat: 37.9741, lon: -87.5558, ind: ["Auto", "River Port"] },
    "South Bend": { t: 3, w: 4.0, lat: 41.6764, lon: -86.2520, ind: ["Edu", "Mfg"] }, 
    "Joliet": { t: 3, w: 4.0, lat: 41.5250, lon: -88.0817, ind: ["Logistics", "Refining"] },
    "Champaign": { t: 4, w: 2.5, lat: 40.1164, lon: -88.2434, ind: ["Edu", "Tech"] },
    "Iowa City": { t: 4, w: 2.5, lat: 41.6611, lon: -91.5302, ind: ["Edu", "Literature"] },
    "Duluth": { t: 3, w: 3.5, lat: 46.7867, lon: -92.1005, ind: ["Shipping", "Paper", "Steel"] },
    "Youngstown": { t: 4, w: 2.0, lat: 41.0998, lon: -80.6495, ind: ["Steel", "3D Printing"] },
    "Flint": { t: 4, w: 3.5, lat: 43.0125, lon: -83.6875, ind: ["Auto", "Water"] },
    "Traverse City": { t: 4, w: 2.0, lat: 44.7631, lon: -85.6206, ind: ["Tourism", "Ag"] }, 
    "Mackinaw City": { t: 4, w: 1.0, lat: 45.7838, lon: -84.7299, ind: ["Tourism", "Ferry"] },
    "Seville": { t: 0, w: 0.5, lat: 41.0095, lon: -81.8643, ind: ["Junction"] },
    "Mt Vernon": { t: 4, w: 1.0, lat: 38.3172, lon: -88.9031, ind: ["Junction"] },
    "Effingham": { t: 4, w: 1.0, lat: 39.1198, lon: -88.5476, ind: ["Junction"] },
    "Sault Ste. Marie": { t: 4, w: 1.5, lat: 46.4953, lon: -84.3453, ind: ["Shipping Locks"] },
    "Port Huron": { t: 4, w: 2.0, lat: 42.9775, lon: -82.4238, ind: ["Border", "Logistics"] },
    "Saginaw": { t: 4, w: 2.0, lat: 43.4195, lon: -83.9508, ind: ["Auto Parts", "Sugar"] },
    "Kalamazoo": { t: 4, w: 2.5, lat: 42.2917, lon: -85.5872, ind: ["Pharma", "Edu"] },
    "Albert Lea": { t: 4, w: 1.5, lat: 43.6480, lon: -93.3683, ind: ["Junction", "Ag"] },
    "Eau Claire": { t: 4, w: 2.0, lat: 44.8113, lon: -91.4985, ind: ["Computing", "Mfg"] },
    "Sheboygan": { t: 4, w: 2.0, lat: 43.7508, lon: -87.7145, ind: ["Mfg", "Cheese"] },
    "Appleton": { t: 4, w: 2.5, lat: 44.2616, lon: -88.4154, ind: ["Paper", "Mfg"] },
    "Gary": { t: 3, w: 5.0, lat: 41.5934, lon: -87.3464, ind: ["Steel", "Casino"] },
    "Springfield": { t: 4, w: 3.0, lat: 39.7817, lon: -89.6501, ind: ["Govt", "Insurance"] },
    "Bloomington": { t: 4, w: 2.5, lat: 40.4842, lon: -88.9937, ind: ["Insurance", "EV Mfg"] },
    "Hannibal": { t: 4, w: 1.5, lat: 39.7084, lon: -91.3585, ind: ["History", "Port"] },
    "Sikeston": { t: 4, w: 1.5, lat: 36.8767, lon: -89.5879, ind: ["Cotton", "Food"] },

    // --- SOUTH ---
    "Atlanta": { t: 1, w: 9.5, lat: 33.7490, lon: -84.3880, ind: ["Logistics", "Media"] },
    "Nashville": { t: 1, w: 7.5, lat: 36.1627, lon: -86.7816, ind: ["Music", "Auto"] },
    "Charlotte": { t: 1, w: 7.5, lat: 35.2271, lon: -80.8431, ind: ["Banking", "Energy"] },
    "Memphis": { t: 1, w: 9.0, lat: 35.1495, lon: -90.0490, ind: ["FedEx", "Medical", "Logistics"] },
    "Birmingham": { t: 2, w: 5.0, lat: 33.5186, lon: -86.8104, ind: ["Steel", "Banking"] },
    "Raleigh": { t: 2, w: 5.0, lat: 35.7796, lon: -78.6382, ind: ["Research", "Pharma"] },
    "Jacksonville": { t: 2, w: 6.0, lat: 30.3322, lon: -81.6557, ind: ["Logistics", "Rail", "Port"] },
    "Knoxville": { t: 3, w: 4.0, lat: 35.9606, lon: -83.9207, ind: ["Nuclear", "Aluminum"] },
    "Chattanooga": { t: 3, w: 4.0, lat: 35.0456, lon: -85.3097, ind: ["Logistics", "Candy"] },
    "Columbia": { t: 3, w: 3.5, lat: 34.0007, lon: -81.0348, ind: ["Govt", "Mfg"] },
    "Charleston SC": { t: 2, w: 6.5, lat: 32.7765, lon: -79.9311, ind: ["Port", "Auto", "Container"] },
    "Richmond": { t: 2, w: 5.0, lat: 37.5407, lon: -77.4360, ind: ["Finance", "Law"] },
    "Pittsburgh": { t: 2, w: 5.5, lat: 40.4406, lon: -79.9959, ind: ["Robotics", "Steel"] },
    "Mobile": { t: 3, w: 4.5, lat: 30.6954, lon: -88.0399, ind: ["Shipbuilding", "Aero"] },
    "Jackson": { t: 3, w: 3.5, lat: 32.2988, lon: -90.1848, ind: ["Auto", "Govt"] },
    "Shreveport": { t: 3, w: 5.0, lat: 32.5252, lon: -93.7502, ind: ["Gaming", "Gas"] },
    "Montgomery": { t: 3, w: 3.5, lat: 32.3668, lon: -86.3000, ind: ["Auto", "Military"] },
    "Savannah": { t: 2, w: 7.5, lat: 32.0809, lon: -81.0912, ind: ["Port", "Logistics", "Auto", "Container"] },
    "Greensboro": { t: 3, w: 4.0, lat: 36.0726, lon: -79.7920, ind: ["Textiles", "Aviation"] },
    "Winston-Salem": { t: 3, w: 4.5, lat: 36.0999, lon: -80.2442, ind: ["Tobacco", "Tech"] }, 
    "Norfolk": { t: 3, w: 4.5, lat: 36.8508, lon: -76.2859, ind: ["Navy", "Port"] },
    "Roanoke": { t: 3, w: 3.5, lat: 37.2710, lon: -79.9414, ind: ["Rail", "Healthcare"] },
    "Lexington": { t: 3, w: 4.0, lat: 38.0406, lon: -84.5037, ind: ["Horses", "Printers"] },
    "Tallahassee": { t: 3, w: 3.0, lat: 30.4383, lon: -84.2807, ind: ["Govt", "Law"] },
    "Greenville": { t: 3, w: 3.5, lat: 34.8526, lon: -82.3940, ind: ["Auto", "Engineering"] },
    "Augusta": { t: 3, w: 3.5, lat: 33.4735, lon: -82.0105, ind: ["Cyber", "Golf"] },
    "Macon": { t: 3, w: 3.0, lat: 32.8407, lon: -83.6324, ind: ["Music", "Kaolin"] },
    "Huntsville": { t: 3, w: 4.5, lat: 34.7304, lon: -86.5861, ind: ["Space", "Defense"] },
    "Dandridge": { t: 0, w: 0.5, lat: 36.0195, lon: -83.4221, ind: ["Junction"] },
    "Tupelo": { t: 4, w: 1.5, lat: 34.2557, lon: -88.7034, ind: ["Furniture", "Ag"] },
    "Meridian": { t: 4, w: 1.5, lat: 32.3643, lon: -88.7034, ind: ["Rail", "Mfg"] },
    "Hattiesburg": { t: 4, w: 2.0, lat: 31.3271, lon: -89.2903, ind: ["Edu", "Military"] },
    "Clarksville": { t: 4, w: 2.5, lat: 36.5298, lon: -87.3595, ind: ["Military", "Appliances"] },
    "Hammond": { t: 4, w: 1.0, lat: 30.5041, lon: -90.4601, ind: ["Junction", "Ag"] },
    "Slidell": { t: 4, w: 1.0, lat: 30.2752, lon: -89.7812, ind: ["Junction", "Tech"] },
    "Tuscaloosa": { t: 4, w: 2.5, lat: 33.2098, lon: -87.5692, ind: ["Edu", "Auto"] },
    "Gadsden": { t: 4, w: 1.5, lat: 34.0143, lon: -86.0069, ind: ["Steel", "Textiles"] },
    "Decatur": { t: 4, w: 2.0, lat: 34.6059, lon: -86.9833, ind: ["Mfg", "Space"] },
    "Athens": { t: 4, w: 2.5, lat: 33.9519, lon: -83.3576, ind: ["Edu", "Music"] },
    "Valdosta": { t: 4, w: 2.0, lat: 30.8333, lon: -83.2803, ind: ["Ag", "Military"] },
    "Lake City": { t: 4, w: 1.5, lat: 30.1847, lon: -82.6341, ind: ["Junction", "Logistics"] },
    "Gainesville": { t: 4, w: 2.5, lat: 29.6516, lon: -82.3248, ind: ["Edu", "Medical"] },
    "Florence": { t: 4, w: 2.0, lat: 34.1954, lon: -79.7626, ind: ["Pharma", "Medical"] },
    "Fayetteville": { t: 4, w: 3.0, lat: 35.0527, lon: -78.8784, ind: ["Military", "Defense"] },
    "Wilmington": { t: 3, w: 2.5, lat: 34.2104, lon: -77.9447, ind: ["Film", "Fiber Optics"] },
    "Myrtle Beach": { t: 3, w: 4.0, lat: 33.6891, lon: -78.8867, ind: ["Tourism", "Golf"] }, 
    "Petersburg": { t: 4, w: 1.5, lat: 37.2279, lon: -77.4019, ind: ["Pharma", "Logistics"] },
    "Paducah": { t: 4, w: 1.5, lat: 37.0834, lon: -88.6000, ind: ["River Logistics"] },
    "Wheeling": { t: 4, w: 1.5, lat: 40.0639, lon: -80.7209, ind: ["Gas", "Steel"] },
    "Charleston WV": { t: 4, w: 2.5, lat: 38.3498, lon: -81.6326, ind: ["Chemicals", "Govt"] },
    "Beckley": { t: 4, w: 1.0, lat: 37.7782, lon: -81.1882, ind: ["Coal", "Tourism"] },
    "Asheville": { t: 4, w: 2.5, lat: 35.5951, lon: -82.5515, ind: ["Tourism", "Brewing"] },
    "Morgantown": { t: 4, w: 1.5, lat: 39.6295, lon: -79.9559, ind: ["Edu", "Coal"] },
    "Cumberland": { t: 4, w: 1.5, lat: 39.6529, lon: -78.7625, ind: ["Rail", "History"] },
    "Hancock": { t: 4, w: 1.0, lat: 39.6973, lon: -78.1767, ind: ["Junction"] },
    "Jackson TN": { t: 4, w: 1.5, lat: 35.6145, lon: -88.8139, ind: ["Junction", "Mfg"] },
    "Pensacola": { t: 3, w: 4.5, lat: 30.4213, lon: -87.2169, ind: ["Navy", "Aero"] }, // V16.5 Survival Node
    "Johnson City": { t: 4, w: 2.5, lat: 36.3134, lon: -82.3535, ind: ["Medical", "Mfg"] }, // V16.5
    "West Memphis": { t: 0, w: 1.0, lat: 35.1440, lon: -90.1848, ind: ["Junction", "Weigh Station"] }, // V16.5 Invisible Choke

    // --- FLORIDA / EAST COAST ---
    "Miami": { t: 1, w: 8.0, lat: 25.7617, lon: -80.1918, ind: ["Finance", "Trade", "Port"] },
    "Key Largo": { t: 4, w: 2.0, lat: 25.0865, lon: -80.4473, ind: ["Tourism", "Seafood"] },
    "Key West": { t: 4, w: 1.5, lat: 24.5551, lon: -81.7800, ind: ["Tourism", "Naval"] },
    "Naples": { t: 4, w: 1.5, lat: 26.1420, lon: -81.7948, ind: ["Tourism", "Ag"] },
    "Fort Myers": { t: 3, w: 4.5, lat: 26.6406, lon: -81.8723, ind: ["Construction", "Tourism"] }, 
    "Fort Lauderdale": { t: 2, w: 3.5, lat: 26.1224, lon: -80.1373, ind: ["Cruise", "Tech"] },
    "West Palm Beach": { t: 3, w: 3.0, lat: 26.7153, lon: -80.0534, ind: ["Finance", "Ag"] },
    "Melbourne": { t: 3, w: 4.0, lat: 28.0836, lon: -80.6081, ind: ["Aerospace", "Tech"] }, 
    "Orlando": { t: 1, w: 8.5, lat: 28.5383, lon: -81.3792, ind: ["Tourism", "Aero"] },
    "Lakeland": { t: 4, w: 2.5, lat: 28.0395, lon: -81.9498, ind: ["Grocer HQ", "Logistics"] },
    "Daytona Beach": { t: 4, w: 2.5, lat: 29.2108, lon: -81.0228, ind: ["Racing", "Tourism"] },
    "Tampa": { t: 2, w: 6.0, lat: 27.9506, lon: -82.4572, ind: ["Defense", "Phosphate"] },
    "Panama City": { t: 3, w: 3.5, lat: 30.1588, lon: -85.6602, ind: ["Port", "Military"] }, 
    "Ocala": { t: 3, w: 4.0, lat: 29.1872, lon: -82.1401, ind: ["Logistics", "Equine"] }, // V16.5 Florida Funnel

   // --- EAST COAST / I-81 CORRIDOR ---
    "Washington": { t: 1, w: 7.0, lat: 38.9072, lon: -77.0369, ind: ["Govt", "Defense"] },
    "Baltimore": { t: 2, w: 6.0, lat: 39.2904, lon: -76.6122, ind: ["Port", "Medical"] },
    "Salisbury": { t: 3, w: 3.5, lat: 38.3607, lon: -75.5994, ind: ["Poultry", "Ag"] }, 
    "Philadelphia": { t: 1, w: 8.0, lat: 39.9526, lon: -75.1652, ind: ["Pharma", "Chemicals"] },
    "New York": { t: 1, w: 9.0, lat: 40.7128, lon: -74.0060, ind: ["Finance", "Media", "Port"] },
    "Boston": { t: 1, w: 7.5, lat: 42.3601, lon: -71.0589, ind: ["Robotics", "Pharma"] },
    "Harrisburg": { t: 3, w: 4.0, lat: 40.2732, lon: -76.8867, ind: ["Govt", "Transport"] },
    "Reading": { t: 3, w: 4.0, lat: 40.3356, lon: -75.9269, ind: ["Mfg", "Pretzels"] }, 
    "Newark": { t: 1, w: 8.0, lat: 40.7357, lon: -74.1724, ind: ["Port", "Air Cargo", "Container", "Logistics"] },
    "Hartford": { t: 3, w: 4.0, lat: 41.7658, lon: -72.6734, ind: ["Insurance", "Aero"] },
    "Albany": { t: 3, w: 3.5, lat: 42.6526, lon: -73.7562, ind: ["Nanotech", "Govt"] },
    "Buffalo": { t: 2, w: 5.0, lat: 42.8864, lon: -78.8784, ind: ["Banking", "Auto"] }, // Standardized name
    "Rochester": { t: 3, w: 3.5, lat: 43.1566, lon: -77.6088, ind: ["Optics", "Imaging"] },
    "Worcester": { t: 3, w: 3.5, lat: 42.2626, lon: -71.8023, ind: ["Biotech", "Edu"] },
    "Annapolis": { t: 4, w: 2.0, lat: 38.9784, lon: -76.4922, ind: ["Naval", "Govt"] },
    "York": { t: 4, w: 2.0, lat: 39.9626, lon: -76.7277, ind: ["Mfg", "Snack Foods"] },
    "Allentown": { t: 3, w: 3.5, lat: 40.6083, lon: -75.4902, ind: ["Logistics", "Mfg"] },
    "Syracuse": { t: 3, w: 3.5, lat: 43.0481, lon: -76.1474, ind: ["Edu", "Medical"] },
    "Providence": { t: 3, w: 3.5, lat: 41.8240, lon: -71.4128, ind: ["Jewelry", "Design"] },
    "Burlington": { t: 3, w: 2.0, lat: 44.4759, lon: -73.2121, ind: ["Edu", "Tech"] },
    "Portland ME": { t: 3, w: 3.0, lat: 43.6591, lon: -70.2568, ind: ["Lobster", "Oil"] },
    "Scranton": { t: 3, w: 3.0, lat: 41.4090, lon: -75.6624, ind: ["Paper", "Logistics"] },
    "Wilmington DE": { t: 3, w: 3.0, lat: 39.7447, lon: -75.5484, ind: ["Chemicals", "Banking"] },
    "Trenton": { t: 3, w: 3.0, lat: 40.2170, lon: -74.7429, ind: ["Govt", "History"] },
    "Jamestown": { t: 4, w: 1.0, lat: 42.0970, lon: -79.2353, ind: ["Mfg", "Engines"] },
    "Elmira": { t: 4, w: 1.5, lat: 42.0898, lon: -76.8077, ind: ["Mfg", "History"] },
    "Kingsport": { t: 4, w: 2.0, lat: 36.5484, lon: -82.5618, ind: ["Chemicals", "Paper"] },
    "Bristol": { t: 4, w: 1.5, lat: 36.5951, lon: -82.1887, ind: ["Music", "Racing"] },
    "Wytheville": { t: 4, w: 1.5, lat: 36.9490, lon: -81.0820, ind: ["Junction"] },
    "Lexington VA": { t: 4, w: 1.0, lat: 37.7840, lon: -79.4428, ind: ["Edu", "History"] },
    "Staunton": { t: 4, w: 1.5, lat: 38.1496, lon: -79.0717, ind: ["Distribution"] },
    "Charlottesville": { t: 4, w: 2.0, lat: 38.0293, lon: -78.4767, ind: ["Edu", "History"] },
    "Lynchburg": { t: 3, w: 3.5, lat: 37.4138, lon: -79.1422, ind: ["Nuclear", "Edu"] }, 
    "Winchester": { t: 4, w: 1.5, lat: 39.1857, lon: -78.1633, ind: ["Apples", "Logistics"] },
    "Hagerstown": { t: 4, w: 2.0, lat: 39.6418, lon: -77.7200, ind: ["Trucking", "Aero"] },
    "State College": { t: 4, w: 2.0, lat: 40.7934, lon: -77.8600, ind: ["Edu", "Tech"] },
    "Wilkes-Barre": { t: 4, w: 2.0, lat: 41.2459, lon: -75.8813, ind: ["Distribution"] },
    "Binghamton": { t: 3, w: 3.0, lat: 42.0987, lon: -75.9180, ind: ["Simulators", "Edu"] },
    "Watertown": { t: 4, w: 1.5, lat: 43.9748, lon: -75.9108, ind: ["Military", "Ag"] },
    "Plattsburgh": { t: 4, w: 1.5, lat: 44.6995, lon: -73.4529, ind: ["Border", "Aero"] },
    "Newburgh": { t: 4, w: 1.5, lat: 41.5034, lon: -74.0104, ind: ["Logistics", "Airport"] },
    "Danbury": { t: 4, w: 2.0, lat: 41.3948, lon: -73.4540, ind: ["Pharma", "History"] },
    "New Haven": { t: 4, w: 3.0, lat: 41.3083, lon: -72.9279, ind: ["Edu", "Biotech"] },
    "Springfield MA": { t: 4, w: 3.0, lat: 42.1015, lon: -72.5898, ind: ["Mfg", "History"] },
    "Manchester NH": { t: 4, w: 2.5, lat: 42.9956, lon: -71.4548, ind: ["Tech", "History"] },
    "Concord NH": { t: 4, w: 2.0, lat: 43.2081, lon: -71.5376, ind: ["Govt", "Law"] },
    "Montpelier": { t: 4, w: 1.0, lat: 44.2601, lon: -72.5754, ind: ["Govt", "Insurance"] },
    "Erie": { t: 3, w: 2.5, lat: 42.1292, lon: -80.0851, ind: ["Locomotives", "Plastics"] },
    "Bangor": { t: 4, w: 1.5, lat: 44.8016, lon: -68.7712, ind: ["Paper", "Casino"] },
    "Houlton": { t: 4, w: 1.0, lat: 46.1264, lon: -67.8402, ind: ["Timber", "Potatoes"] },
    "St Johnsbury": { t: 4, w: 1.0, lat: 44.4192, lon: -72.0148, ind: ["Maple", "Tourism"] },
    "Sturbridge": { t: 0, w: 0.5, lat: 42.1084, lon: -72.0787, ind: ["Junction"] },
    "White River Jct": { t: 0, w: 0.5, lat: 43.6481, lon: -72.3190, ind: ["Junction"] }, 
    "Bedford": { t: 0, w: 0.5, lat: 40.0195, lon: -78.5039, ind: ["Junction"] },
    "Drums": { t: 0, w: 0.5, lat: 41.0189, lon: -75.9928, ind: ["Junction"] },
    "Strasburg": { t: 0, w: 0.5, lat: 38.9897, lon: -78.3586, ind: ["Junction"] },
    "Breezewood": { t: 4, w: 2.5, lat: 39.9994, lon: -78.2387, ind: ["Fast Food", "Traffic Jams"] },
    "Avoca": { t: 0, w: 0.5, lat: 42.4087, lon: -77.4262, ind: ["Junction"] },
    "Rando Cali": { t: 0, w: 0.5, lat: 37.582555, lon: -121.3547438, ind: ["Junction"] },
    "Atlantic City": { t: 3, w: 2.5, lat: 39.3643, lon: -74.4229, ind: ["Tourism", "Casino"] },
    "New Stanton": { t: 0, w: 1.0, lat: 40.2198, lon: -79.6014, ind: ["Junction", "Turnpike"] }, // V16.5 Invisible Choke
    "Rocky Mount": { t: 0, w: 1.0, lat: 35.9382, lon: -77.7905, ind: ["Junction", "Logistics"] }, // V16.5 Invisible Choke
    "Hillsboro": {
    t: 0,
    w: 1.0,
    lat: 32.0110,
    lon: -97.1294,
    ind: ["Junction"]},
    
        // --- GULF & DEEP SOUTH FILLERS ---
    "Brunswick": { t: 4, w: 2.5, lat: 31.1499, lon: -81.4915, ind: ["Port", "Auto Imports"] }, // Breaks up the long I-95 Savannah-Jax void
    "Monroe": { t: 4, w: 2.0, lat: 32.5093, lon: -92.1193, ind: ["Ag", "Telecom"] },          // Crucial I-20 gap filler between Shreveport and Jackson MS
    "Gulfport": { t: 3, w: 3.0, lat: 30.3674, lon: -89.0928, ind: ["Port", "Casinos"] },      // Breaks up the I-10 Mobile-NOLA void
    "Tyler": { t: 4, w: 2.0, lat: 32.3512, lon: -95.3010, ind: ["Medical", "Mfg"] },          // East Texas I-20 freight generator

    // --- I-95 MEGALOPOLIS DENSITY BOOSTERS ---
    // These will massively increase short-haul truck spawns along the Northeast Corridor
    "Edison": { t: 3, w: 5.0, lat: 40.5187, lon: -74.4120, ind: ["Logistics", "Distribution"] }, // The massive warehouse hub of NJ
    "Bridgeport": { t: 3, w: 3.5, lat: 41.1792, lon: -73.1894, ind: ["Mfg", "Finance"] },        // Breaks up NY to New Haven
    "Fredericksburg": { t: 4, w: 2.0, lat: 38.3031, lon: -77.4605, ind: ["History", "Retail"] }, // The notorious I-95 traffic choke south of DC
    "Portsmouth": { t: 4, w: 1.5, lat: 43.0717, lon: -70.7625, ind: ["Naval", "Port"] },         // Bridges the gap from Boston to Maine

    // --- MIDWEST / PLAINS MISSING LINKS ---
    "Dayton": { t: 3, w: 4.5, lat: 39.7589, lon: -84.1916, ind: ["Aero", "Logistics"] },         // Massive I-75 missing link between Cincinnati and Toledo
    "Ann Arbor": { t: 3, w: 3.5, lat: 42.2808, lon: -83.7430, ind: ["Edu", "Tech"] },            // Bridges Detroit to Kalamazoo on I-94
    "Raton": { t: 0, w: 0.8, lat: 36.9033, lon: -104.4391, ind: ["Junction", "Mountain Pass"] }, // Vital I-25 choke between Pueblo and Santa Fe

    
};
// --- INTERSTATE ROUTES (V16.5 - Updated Topology & Invisible Chokes) ---
export const interstateRoutes = {
    "I-2": ["McAllen", "Harlingen"],
    "I-4": ["Tampa", "Lakeland", "Orlando", "Daytona Beach"], 
    "I-5": ["San Diego", "Long Beach", "Los Angeles", "Mettler", "Stockton", "Sacramento", "Redding", "Medford", "Eugene", "Salem", "Portland", "Olympia", "Tacoma", "Seattle", "Everett", "Blaine"],
    "I-8": ["San Diego", "Yuma", "Casa Grande"],
    
    // I-10: Desert void fixed, Quartzsite choke added, Pensacola added (Tucumcari strictly removed)
    "I-10": ["Santa Monica", "Los Angeles", "Riverside", "San Bernardino", "Quartzsite", "Phoenix", "Casa Grande", "Tucson", "Las Cruces", "El Paso", "Van Horn", "Scroggins Draw", "Fort Stockton", "Kerrville", "San Antonio", "Houston", "Beaumont", "Lake Charles", "Lafayette", "Baton Rouge", "Laplace", "New Orleans", "Slidell", "Gulfport", "Mobile", "Pensacola", "Tallahassee", "Lake City", "Jacksonville"], 
    
    "I-11": ["Reno", "Las Vegas", "Kingman", "Phoenix"],
    "I-12": ["Baton Rouge", "Hammond", "Slidell"],
    "I-14": ["Killeen", "Temple"], 
    "I-15": ["San Diego", "Riverside", "San Bernardino", "Barstow", "Las Vegas", "St. George", "Cove Fort", "Provo", "Salt Lake City", "Ogden", "Tremonton", "Pocatello", "Idaho Falls", "Butte", "Helena", "Great Falls", "Sweetgrass"],
    "I-16": ["Macon", "Savannah"],
    "I-17": ["Phoenix", "Flagstaff"],
    "I-19": ["Tucson", "Nogales"], 
    "I-20": ["Scroggins Draw", "Odessa", "Midland", "Abilene", "Fort Worth", "Dallas", "Tyler", "Shreveport", "Monroe", "Jackson", "Meridian", "Tuscaloosa", "Birmingham", "Atlanta", "Augusta", "Columbia", "Florence"],
    "I-22": ["Memphis", "Tupelo", "Birmingham"],
    "I-24": ["Mt Vernon", "Paducah", "Clarksville", "Nashville", "Chattanooga"],
    "I-25": ["Las Cruces", "Albuquerque", "Santa Fe", "Raton", "Pueblo", "Colorado Springs", "Denver", "Fort Collins", "Cheyenne", "Casper", "Buffalo WY"],
    
    // I-26: Appalachian extension with Johnson City
    "I-26": ["Kingsport", "Johnson City", "Asheville", "Columbia", "Charleston SC"],
    
    "I-27": ["Lubbock", "Amarillo"],
    "I-29": ["Kansas City", "St. Joseph", "Sioux City", "Sioux Falls", "Fargo", "Grand Forks", "Pembina"],
    "I-30": ["Fort Worth", "Dallas", "Texarkana", "Little Rock"],
    
    // I-35: Hillsboro split added for FW/Dallas logic
    "I-35": ["Laredo", "San Antonio", "Austin", "Temple", "Waco", "Hillsboro", "Dallas", "Denton", "Oklahoma City", "Wichita", "Kansas City", "Des Moines", "Albert Lea", "Minneapolis", "Duluth"],
    "I-35W": ["Hillsboro", "Fort Worth", "Denton"], // Connects FW to the spine
    "I-35E": ["Hillsboro", "Dallas", "Denton"], 
    
    "I-37": ["Corpus Christi", "San Antonio"],
    
    // I-40: Voids fixed, West Memphis Mississippi bridge choke added
    "I-40": ["Barstow", "Kingman", "Flagstaff", "Gallup", "Albuquerque", "Tucumcari", "Amarillo", "Oklahoma City", "Fort Smith", "Little Rock", "West Memphis", "Memphis", "Jackson TN", "Nashville", "Knoxville", "Dandridge", "Asheville", "Winston-Salem", "Greensboro", "Raleigh", "Wilmington"],
    
    "I-41": ["Milwaukee", "Appleton", "Green Bay"],
    "I-43": ["Milwaukee", "Sheboygan", "Green Bay"],
    "I-44": ["Wichita Falls", "Lawton", "Oklahoma City", "Tulsa", "Joplin", "Springfield MO", "Rolla", "St. Louis"],
    "I-45": ["Galveston", "Houston", "Dallas"],
    "I-49": ["Lafayette", "Alexandria", "Shreveport", "Texarkana", "Fort Smith", "Fayetteville AR", "Joplin", "Kansas City"],
    "I-55": ["Laplace", "Hammond", "Jackson", "Memphis", "Sikeston", "St. Louis", "Springfield", "Bloomington", "Joliet", "Chicago"], 
    "I-57": ["Sikeston", "Mt Vernon", "Effingham", "Champaign", "Chicago"],
    "I-59": ["Slidell", "Hattiesburg", "Meridian", "Tuscaloosa", "Birmingham", "Gadsden", "Chattanooga"],
    "I-64": ["St. Louis", "Mt Vernon", "Louisville", "Lexington", "Charleston WV", "Beckley", "Lexington VA", "Staunton", "Charlottesville", "Richmond", "Norfolk"],
    "I-65": ["Mobile", "Montgomery", "Birmingham", "Huntsville", "Nashville", "Louisville", "Indianapolis", "Gary"],
    "I-66": ["Washington", "Strasburg"],
    "I-68": ["Morgantown", "Cumberland", "Hancock"],
    "I-69": ["Houston", "Shreveport", "Pine Bluff", "Memphis", "Paducah", "Evansville", "Indianapolis", "Fort Wayne", "Lansing", "Port Huron"],
    
    // I-70: High plains gap bridged, Silverthorne mountain choke, New Stanton turnpike choke
    "I-70": ["Cove Fort", "Price", "Grand Junction", "Silverthorne", "Denver", "Limon", "Colby", "Hays", "Salina", "Topeka", "Kansas City", "Columbia MO", "St. Louis", "Effingham", "Indianapolis", "Columbus", "Wheeling", "New Stanton", "Pittsburgh", "Breezewood", "Hancock", "Hagerstown", "Baltimore"],
    
    "I-71": ["Louisville", "Cincinnati", "Columbus", "Seville", "Cleveland"],
    "I-72": ["Hannibal", "Springfield", "Champaign"],
    "I-74": ["Davenport", "Peoria", "Bloomington", "Champaign", "Indianapolis", "Cincinnati"],
    
    // I-75: Ocala added to naturally break up Florida funnels
    "I-75": ["Sault Ste. Marie", "Mackinaw City", "Saginaw", "Flint", "Detroit", "Toledo", "Dayton", "Cincinnati", "Lexington", "Knoxville", "Chattanooga", "Atlanta", "Macon", "Valdosta", "Lake City", "Gainesville", "Ocala", "Tampa", "Fort Myers", "Naples", "Miami"],
    
    "I-76 (West)": ["Denver", "Sterling", "Big Springs"],
    "I-76 (East)": ["Seville", "Akron", "Pittsburgh", "Bedford", "Breezewood", "Harrisburg", "Reading", "Philadelphia"], 
    "I-77": ["Columbia", "Charlotte", "Wytheville", "Beckley", "Charleston WV", "Akron", "Cleveland"],
    "I-78": ["Harrisburg", "Allentown", "Newark", "New York"],
    "I-79": ["Charleston WV", "Morgantown", "Pittsburgh", "Erie"],
    
    // I-80: Battle Mountain gap bridged, Laramie bypass choke, Council Bluffs paced
    "I-80": ["San Francisco", "Oakland", "Sacramento", "Reno", "Winnemucca", "Battle Mountain", "Elko", "Wells", "Salt Lake City", "Ogden", "Rock Springs", "Rawlins", "Laramie", "Cheyenne", "Big Springs", "North Platte", "Kearney", "Lincoln", "Council Bluffs", "Omaha", "Des Moines", "Iowa City", "Davenport", "Joliet", "Gary", "South Bend", "Toledo", "Cleveland", "Youngstown", "State College", "Drums", "New York"],
    
    "I-81": ["Dandridge", "Kingsport", "Bristol", "Wytheville", "Roanoke", "Lexington VA", "Staunton", "Strasburg", "Winchester", "Hagerstown", "Harrisburg", "Drums", "Wilkes-Barre", "Scranton", "Binghamton", "Syracuse", "Watertown"],
    "I-82": ["Ellensburg", "Yakima", "Kennewick", "Hermiston"], 
    "I-83": ["Harrisburg", "York", "Baltimore"],
    "I-84 (West)": ["Portland", "The Dalles", "Hermiston", "Pendleton", "Boise", "Twin Falls", "Heyburn", "Tremonton", "Ogden"],
    "I-84 (East)": ["Scranton", "Newburgh", "Danbury", "Hartford", "Sturbridge"], 
    "I-85": ["Montgomery", "Atlanta", "Athens", "Greenville", "Charlotte", "Greensboro", "Petersburg"],
    "I-86 (East)": ["Erie", "Jamestown", "Avoca", "Elmira", "Binghamton"],
    "I-86 (West)": ["Heyburn", "Pocatello"],
    "I-87": ["New York", "Albany", "Plattsburgh"],
    "I-88 (West)": ["Davenport", "Chicago"],
    "I-88 (East)": ["Binghamton", "Albany"], 
    "I-89": ["Concord NH", "White River Jct", "Montpelier", "Burlington"],
    
    // I-90: Badlands gap bridged (Mitchell)
    "I-90": ["Seattle", "Ellensburg", "Spokane", "Coeur dAlene", "Missoula", "Butte", "Bozeman", "Billings", "Buffalo WY","Gillette", "Rapid City", "Mitchell", "Sioux Falls", "Albert Lea", "Madison", "Rockford", "Chicago", "Gary", "South Bend", "Toledo", "Cleveland", "Erie", "Buffalo", "Rochester", "Syracuse", "Albany", "Sturbridge", "Worcester", "Boston"],
    
    "I-91": ["New Haven", "Hartford", "Springfield MA", "White River Jct", "St Johnsbury"],
    "I-93": ["Boston", "Manchester NH", "Concord NH", "White River Jct", "St Johnsbury"],
    "I-94": ["Billings", "Miles City", "Dickinson", "Bismarck", "Fargo", "Minneapolis", "Eau Claire", "Milwaukee", "Chicago", "Gary", "Kalamazoo", "Ann Arbor", "Detroit", "Port Huron"],
    
    // I-95: Rocky Mount pacing choke added
    "I-95": ["Miami", "Fort Lauderdale", "West Palm Beach", "Melbourne", "Daytona Beach", "Jacksonville", "Brunswick", "Savannah", "Florence", "Fayetteville", "Rocky Mount", "Petersburg", "Richmond", "Fredericksburg", "Washington", "Baltimore", "Wilmington DE", "Philadelphia", "Trenton", "Edison", "Newark", "New York", "Bridgeport", "New Haven", "Providence", "Boston", "Portsmouth", "Portland ME", "Bangor", "Houlton"],
    
    "I-96": ["Detroit", "Lansing", "Grand Rapids"],
    "I-97": ["Annapolis", "Baltimore"],
    "I-99": ["State College", "Bedford"], 
    "I-135": ["Salina", "Wichita"],
    "I-380": ["Iowa City", "Cedar Rapids"], 
    "I-215": ["San Bernardino", "Riverside"], 
};

// --- HIGHWAY ROUTES (V16.5 - The Realism & Triangle Layer) ---
export const highwayRoutes = {
    // California Spine
    "CA-99": ["Mettler", "Bakersfield", "Visalia", "Fresno", "Modesto", "Stockton", "Sacramento"],
    "US-101": ["Los Angeles", "Santa Barbara", "San Luis Obispo", "Monterey", "San Jose", "San Francisco", "Santa Rosa", "Eureka", "Medford"],
    
    // V16.5: The Legendary Tehachapi Pass (Massive SoCal freight corridor)
    "CA-58": ["Bakersfield", "Tehachapi", "Barstow"],

    // The "Loneliest Road" (Central Corridor)
    "US-50": ["Sacramento", "South Lake Tahoe", "Carson City", "Fallon", "Ely", "Delta UT", "Price", "Grand Junction", "Montrose", "Pueblo"],
    
    // The Northern Frontier
    "US-2": ["Everett", "Spokane", "Williston", "Minot", "Grand Forks", "Duluth"],
    
    // The Oregon Trail / Northwest Connector
    "US-26": ["Portland", "Madras", "Bend", "Burns", "Boise", "Idaho Falls", "Jackson Hole", "Casper", "Scottsbluff", "North Platte"],
    
    // Eastern Sierra & Inland Northwest
    "US-395": ["Reno", "Susanville", "Burns", "Pendleton", "Kennewick", "Spokane"],
    
    // Gulf & Texas Connectors
    "US-287": ["Fort Worth", "Wichita Falls", "Amarillo", "Boise City", "Denver", "Fort Collins", "Laramie"], // Extended for Rocky bypass
    "US-98": ["Mobile", "Panama City", "Tallahassee"],
    
    // V16.5 TACTICAL ADDITIONS (Economic Arteries)
    "US-59": ["Brownsville", "McAllen", "Laredo", "Victoria", "Houston"], // The NAFTA Freight Corridor
    "US-290": ["Austin", "Houston"], // The Texas Triangle Shortcut
    "US-87": ["San Antonio", "San Angelo", "Lubbock"], // Texas Oil & Ag Connectors
    "US-412": ["Tulsa", "Fayetteville AR"], // Crucial Midwest cross-route
    "US-20": ["Rockford", "Dubuque"], // Upper Midwest Logistics link
    
    // Atlantic Seaboard
    "US-1": ["Miami", "Key Largo", "Key West"],
    "US-13": ["Wilmington DE", "Salisbury", "Norfolk"], 
    "US-17": ["Wilmington", "Myrtle Beach", "Charleston SC", "Savannah"],
    "US-29": ["Greensboro", "Lynchburg", "Charlottesville", "Washington"],
    
    // Misc
    "US-93": ["Las Vegas", "Ely", "Wells", "Twin Falls"],
    "US-131": ["Grand Rapids", "Traverse City"],
    "AC-Expressway": ["Philadelphia", "Atlantic City"]
};

// --- V16.6 SUPREME TERRAIN MODIFIERS (Realism Meets Tycoon) ---
// Base Interstate: 70 MPH | Base Highway: 55 MPH

export const terrainModifiers = {
    // --- APPALACHIA & EAST COAST CHOKEPOINTS ---
    "Morgantown-Cumberland": 50,
    "Cumberland-Hancock": 50,
    "Charleston WV-Beckley": 45,
    "Beckley-Wytheville": 50,
    "Knoxville-Dandridge": 55,
    "Dandridge-Asheville": 45,       // The Gorge (Steep & Winding)
    "Beckley-Lexington VA": 50,
    "Richmond-Washington": 50,       // Perpetual I-95 Traffic
    
    // --- MEGALOPOLIS (Heavy Urban Traffic) ---
    "Washington-Baltimore": 40,
    "Baltimore-Wilmington DE": 45,
    "Wilmington DE-Philadelphia": 40,
    "Philadelphia-Trenton": 45,
    "Trenton-Newark": 40,
    "Newark-New York": 35,           // Extreme traffic / Bridge tolls
    "New York-New Haven": 40,
    "New Haven-Providence": 50,
    "Providence-Boston": 40,
    "Chicago-Gary": 45,
    "Chicago-Joliet": 50,
    "Atlanta-Macon": 55,
    "Atlanta-Greenville": 60,        // I-85 Freight Congestion
    "Greenville-Charlotte": 60,
    "Tampa-Lakeland": 55,
    "Lakeland-Orlando": 55,
    "Orlando-Daytona Beach": 60,

    // --- CALIFORNIA (Strict 55 MPH Truck Limits) ---
    "Los Angeles-San Bernardino": 45,
    "Los Angeles-Santa Monica": 30,  // I-10 Parking lot
    "Los Angeles-San Diego": 50,
    "San Francisco-San Jose": 45,
    "San Jose-Gilroy": 55,
    "Mettler-Bakersfield": 55,       // Corrected from 75mph
    "Bakersfield-Fresno": 55,        // Corrected from 75mph
    "Fresno-Modesto": 55,            // CA-99 Ag traffic
    "Modesto-Stockton": 55,
    "Stockton-Sacramento": 55,

    // --- THE ROCKIES & SIERRAS (Organic Convoy Generators) ---
    "Denver-Silverthorne": 40,         // Eisenhower Tunnel grade (Massive slowdown)
    "Silverthorne-Grand Junction": 50, // Downhill/Winding
    "Grand Junction-Montrose": 50, 
    "Montrose-Pueblo": 45, 
    "Grand Junction-Cove Fort": 50,
    "Salt Lake City-Rock Springs": 55,
    "Cheyenne-Rawlins": 55,
    "Sacramento-Reno": 45,             // Donner Pass (I-80 Climb)
    "Seattle-Ellensburg": 45,          // Snoqualmie Pass (I-90 Cascades)
    "Pendleton-Boise": 50,             // Cabbage Hill / Blue Mountains
    "Redding-Medford": 50,             // Mount Shasta climb
    "South Lake Tahoe-Carson City": 45, 
    "Everett-Spokane": 50, 
    "Portland-Madras": 45, 
    "Bakersfield-Tehachapi": 40,       // Brutal climb out of San Joaquin
    "Tehachapi-Barstow": 55,           // Dropping into Mojave

    // --- THE DESERT VOIDS & MODERATE CLIMBS ---
    "Phoenix-Flagstaff": 45,           // Steep climb up I-17
    "Kingman-Flagstaff": 55,
    "Flagstaff-Gallup": 65,     
    "Gallup-Albuquerque": 65,   
    "Reno-Winnemucca": 65,      
    "Winnemucca-Battle Mountain": 65, 
    "Ely-Delta UT": 60, 
    "Denver-Limon": 65,         
    "San Antonio-Kerrville": 60,
    
    // --- TEXAS TRIANGLE CHOKEPOINTS ---
    "Austin-Temple": 55,               // I-35 Construction/Congestion
    "Temple-Waco": 55,
    "Waco-Hillsboro": 55,
    "Beaumont-Lake Charles": 50,       // Calcasieu River Bridge bottleneck

    // --- THE HIGH PLAINS & DESERT SPEEDWAYS ---
    // These allow 80-85 MPH, rewarding players for routing through empty states
    "Omaha-Lincoln": 75,
    "Lincoln-Kearney": 80,
    "Kearney-North Platte": 80,
    "North Platte-Big Springs": 80,
    "Big Springs-Cheyenne": 80,
    "Kansas City-Topeka": 75,
    "Topeka-Salina": 80,
    "Salina-Hays": 80,
    "Hays-Denver": 80,
    "Sioux City-Sioux Falls": 80,
    "Sioux Falls-Fargo": 80,
    "Fargo-Grand Forks": 80,
    "Rapid City-Mitchell": 80,         // I-90 South Dakota speedway
    "Bismarck-Dickinson": 80,          // I-94 North Dakota
    "Dickinson-Miles City": 80,        // Montana plains
    "Miles City-Billings": 80,
    "Tremonton-Pocatello": 80,         // I-15 Idaho straightaway
    "Pocatello-Idaho Falls": 80,
    "San Antonio-Scroggins Draw": 80,
    "Scroggins Draw-Van Horn": 85,     // I-10 in West TX is incredibly fast
    "Van Horn-El Paso": 80,
    "Abilene-Midland": 80,             // I-20 Texas oil flats
    "Midland-Odessa": 80,
    "Albuquerque-Amarillo": 80,
    "Amarillo-Oklahoma City": 80,
    
    //NEW to bulk map
    "Richmond-Fredericksburg": 50,
    "Fredericksburg-Washington": 40,
    "Santa Fe-Raton": 55,

};
