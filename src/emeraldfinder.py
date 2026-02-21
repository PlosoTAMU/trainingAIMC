y = 102

initial = [-419.5, 130.5]

offsetx = -419.5 - (-359.5)
offsetz1 = 130.5 - 70.5 # next box
offsetz2 = 130.5 - 110.5 # other side

pairings = []

for i in range(8):
    xvalue = initial[0] - offsetx * i
    for j in range(8):
        zvalue = initial[1] - offsetz1 * j
        opponentzvalue = initial[1] - offsetz2 * j
        pairings.append({"Bot1": (xvalue, y, zvalue), "Bot2": (xvalue, y, opponentzvalue)})
print(pairings)


    