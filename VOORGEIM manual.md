This is the game manual draft for the board game. It has not yet been ordered into a cohesive printable manual but it contains all the necessary rules and information of the game at its current state.

# Strategic Map

The map currently holds 28 locations or nodes which can be contested. Each location has 1-3 division slots on both sides where the players can move their units to. The players can only place units on the side of the node facing their “home direction”, leaving the other half of the node empty. Exception to this is the asymmetric nodes where a player can spend an action to change the defensive direction to occupy a side with a different number of division slots.

## Unit movement and movement nodes

Movement paths connect the locations to allow unit movement between them

All units must follow the movement paths when moving on the strategic map. Each division slot in a location can only hold one army. Locations with only a single slot are intentional chokepoints and armies cannot pass "over" each other even if the player had 2 strategic actions remaining.

Land units can use sea connections but cannot initiate battles in sea nodes, allowing opposing armies to pass each other

Indirect fire paths allow fire support from nearby nodes indicated by the red arrows when a battle happens in the targeted node.

Indirect fire is only allowed to the direction indicated by the arrow  
      
Sea nodes allow land units to transport by sea but battles cannot commence over sea nodes even if opposing forces would meet in a sea node. 

Sea nodes can always supply only 2 unit per node and cannot be used for reorganizing armies.

## Asymmetric nodes

Empty asymmetric nodes (1v2, 2v3) have their frontlines occupied from the direction of approach. A player may use a strategic action to move within the empty node to occupy the other side of it instead. In case the position is contested after the player moves to occupy the node from the other side, the opponent will now enter the battle from the "wrong side". 

If a friendly unit is present in an asymmetric node, any entering friendly units will join the same side regardless of the approach direction.

## Staging area / home base

A location with no supply cap where a player can keep their units which haven't been sent to action. Staging area always allows reorganizing units to armies and hiding their identity even if the nearby nodes would be contested.  

## Movement supply limit

Each location in the map has a supply limit which limits the number of units that can stay organized in the node. 

Armies can move to a node to "over stack" but only the limited number of units can stay organized in the armies and the remaining units enter the disorganized state. 

Movement nodes can momentarily exceed the maximum supply capacity as long as the units are moved to within supply limits before the end of the strategic phase. If any node contains more units that can be supplied after the 2 strategic actions allowed in one player turn, the excess units from the most recently moved army will enter the disorganized state.

Any number of disorganized units in a location will use 1 supply, but they do not block movement into the division slots of the node for armies. This allows players to move their armies past any disorganized units and to collect the disorganized units in controlled locations to reorganize them.

## Controlled and contested locations

A location is considered controlled when it is occupied by at least one friendly army (disorganized individual units don't count) and none of the adjacent connected locations are occupied by the opposing player. 

Controlled nodes can supply 6 units per available division slot.

Reorganizing armies is only allowed in controlled locations.

If an opposing player attacks a controlled location (ie. moves across an empty location to a defended node), all organized defensive units will join the battle. The defender does not choose their force: defence is never something a player opts part of their garrison out of, which is what keeps a won battle meaningful. If the location held more units than can fit the battle board, the defender can freely select which units to use. However, the selection must be done when the battle is initiated and units cannot be swapped once the deployment starts.

A location node is considered contested when any of its adjacent nodes are occupied by the enemy and thus could be attacked during the next turn.

Contested nodes can supply 3 units in each division slot

If a location turns from controlled to contested while holding more units than can be supplied in the contested state, the player must move the excess units during their next strategic turn or they become disorganized. 

## Fog of war
Opposing units stay hidden (face down on board) until revealed by recon or engaged in a battle.

Revealed units can be reorganized in controlled locations to hide their identity again

# Armies and disorganized units
Players start with individual units which need to be organized into armies in the staging area or in controlled locations. Organizing units into an army uses one player action of the turn.

Initial units when starting the game:   
10x Infantry  
5x Artillery  
4x Anti-Tank  
4x Armor  
2x Recon

Players can have a total of 10 active armies.

An army can consist of any number of units, but in practice the number needs to be 6 or less to be able to move to any location.  

An army is displayed on the strategic map with the individual units grouped together using the army frame.

Units on the strategic map can have 2 states: 

    In armies - Units stacked into armies which can be used in battles

    Disorganized - Individual units that aren't part of armies. These units can freely move in the strategic map to neutral or friendly nodes but will need to be organized into armies to be used in battles. 

2 Disorganized units located in the same node can be moved together as one action.

## Overrunning disorganized units

If disorganized units are caught by enemy armies on the strategic map, they will be considered overrun and removed from the game.

If a player loses a battle in a location they have disorganized units, these units do not automatically withdraw with the possible withdrawn battle units. Instead the player will have to move them using their strategic actions or protect them by bringing an army into the location. 
If an opposing army is present in the location after the battle, unprotected disorganized units will be overran by the army at the beginning of the opposing player's turn. 
This means initiative being in favor of the player with the disorganized units may give them an additional turn to save the units, or they may be overran in the very next sequence of actions if the initiative was in favor of the opponent.  

# Units

## Unit properties 

Unit type - Soft or hard target type

Soft attack - Damage against soft targets

Hard attack - Damage against hard targets

Breakthrough - Number of offensive dice rolls

Toughness - Number of defensive dice rolls

Hitpoints - How much damage the unit can take before being wounded or destroyed

## Unit types {#unit-types}

| Unit | Target type | S | H | B | T | HP  |
| :---- | :---- | :---- |
| Infantry  | Soft target | 2 | 1 | 1 | 3 | 4 |
| Wounded Infantry | Soft target | 1 | 0 | 1 | 3 | 1 |
| Artillery | Soft target | 3 | 1 | 2 | 2 | 2 |
| Anti-tank | Soft target | 1 | 3 | 2 | 2 | 2 |
| Armor | Hard target | 2 | 2 | 3 | 1 | 4 |

## Defensive fortifications 

Players can spend their strategic actions to construct defensive fortifications in locations they hold armies in. Each fortification built is added to the army units and must be deployed in the next battle that happens in the location. 

Fortifications are temporary and location specific on the strategic map. They cannot be moved along the armies and they will be removed from the location if all armies are moved away. 

A deployed fortification in a battle is a stationary object on a single movement cell of the battle board. 
The fort has 2 HP which will absorb any incoming damage before the unit occupying the cell takes any HP damage. An "overkill" on a fortification will remove the fort but any excess damage above the fort's HP will not be transferred to the occupying unit. For example a fortification with 1 HP remaining will fully absorb a 4HP critical hit from an artillery unit and protect the unit in the cell.

Fortifications defend against attacks from the front and both sides (5 positions), but attacks from behind or the rear corners are not defended by the fortification. 

Fortifications do not affect damage, breakthrough or toughness stats of the units.

Fortifications do not protect occupying units from damage received from critical failures on offensive or defensive rolls

A fortification can be occupied by an enemy unit and the defensive benefits apply until the fort is destroyed. If an enemy unit occupies a fortification on the opposing side of the frontline, the fort will not offer protection against indirect fire support which is considered to be coming from the rear. 


## Recon 

Recon units are used to reveal hidden enemy units. They are only present in the strategic map and move independently from the armies and fighting units. Recon units will not take part in battles. 

Players start with 2 recon units which cannot be replenished if they are lost through failed recon attempts.

Recon units can move between the locations and behind enemy lines without initiating battles. Recon unit can be present in a location with an army without using any supplies.

Dice roll to attempt to recon the enemy forces in the same node

    1 - Critical failure - Recon unit destroyed

    2 - Failure - No results

    3 - Partial success - Display 1 units from from the selected army

    4 - Success - Display 2 units from from the selected army

    5 - Great success - Display all enemy units from the selected army

    6 - Critical success - Display all enemy units in all armies in the location

# Battles 

## Choosing the assault force

The attacking player decides which of their armies in the location take part in the battle. Armies left out do not enter the battle board at all: they stay in the strategic map, organized and are untouched by the battle result. If the attacker has multiple armies present, this allows a "probing assault" with one army while another is held back for later operations.
All units from an army selected for the battle must be committed to the deployment, in most cases preventing leaving a single unit on the strategic map to keep the location contested. 

The defender must always commit all available organized units from the location into the battle. Otherwise it would be possible to force multiple "pointless" battles against small armies before the location is captured. 

Disorganized units never join a battle on either side, whoever initiated it.
Wounded units cannot join an offensive battle, but will join on defender's side.
In case either player or both have more units in their committed armies than can fit on the battle board (12), the leftover units stay organized in the battle location in the strategic map.

## Unit deployment

Player with units in a defended location (enemy units present) can decide to attack and initiate a battle that is fought on the battle board. All unit coins from the strategic map that are involved in the battle are moved on to the tactical battle board.

Players draw unit cards matching their units and display them next to the battle board to keep track of each active unit’s HP. Players should attempt to keep the cards roughly in the same shape as the units on the board to make sure they are tracking the correct units. 

Players deploy their units on their sides of the battle board taking turns one row of the board at the time starting from the frontline.   
Players cannot deploy more units to the previous row after the opponent deployed theirs. If a player fails to fit all their units on the battle board due to mistakes in their deployment, the leftover units will not take part in the battle.  
	  
Players do not have to deploy all their units to battle if they don’t want to. The remaining units will stay on the strategic map and maintain organized state. 

If either side had constructed fortifications, these must be deployed on the board with the units.

### Deployment order

If neither player had reconed the enemy forces, the attacker starts the deployment phase.

If one side had any of their units reconed while the other stayed fully hidden, the player with revealed units will start the deployment regardless of whether they are attacking or defending. 

In case both players have partially revealed any of the opposing forces, attacker deploys first.

Defender must deploy at least one unit adjacent to the attacker units to avoid forcing movement to offset attacker / defender roles.

If the defender was forced to deploy their units first due to recon advantage by the attacker, they must start by deploying at least one unit to the first row of the deployment grid.

## Battle gameplay loop 

Players take turns to take 1 action in the battle map, started by the attacker. Players must take an action on their turn.

One action can be any of the following:

    Attack an enemy unit with one of their own

    Move a unit into an empty adjacent location in any 8 directions

    Withdraw a unit from the battle if the unit is located in the last row of the deployment grid

    Use their indirect fire support or withdraw the support unit from the battle

### Attacking enemy units 

Units are able to move and attack against adjacent locations in all 8 directions including across the initial frontline of the battle board.

Attacks are individual Unit vs Unit attacks, the breakthrough / toughness value defines how many dice are rolled by both sides, greatest value defines the outcome

    Example of a battle roll: 

    Unit with 3 breakthrough rolls 3 dice to attack, unit with 2 toughness rolls only 2 to defend

    Attacker rolls values 4, 2, 3 and defender rolls values 1, 5

    The attack and defend values used for the combat are 4 for the attacker and 5 for the defender.

A successful attack by a frontline unit (ie. anything else than artillery) that destroys the opposing enemy moves the attacking unit to the location of the defeated enemy. 

## Finishing battles

Battle phase ends in a victory of one side or in a stalemate. Any units that took damage but were not destroyed or wounded will be available as normally after the battle and are considered reinforced automatically. For example an Artillery unit that takes 1 HP damage during a victorious battle will be available with full HP on the next turn if the unit is engaged in another battle. For [wounded](#infantry) and [withdrawn units](#withdrawn-units) see the respective sections of the manual

### Victory conditions 

Battle ends in a victory for a player when the opposing side has all their units destroyed or withdrawn from the battle board.  

After a victorious battle, the winner can freely reorganize the battle units into armies that stay in the location of the battle. 
		  
Battle ends in a stalemate if the attacker withdraws all units to the rearmost line of the battle board and the defender does not attempt to contest the stalemate by moving their units over the initial frontline to the opposing side of the board.   
In case the attacker army initially had more units than the battle line width, the excess units must be withdrawn from the battle to allow the stalemate to occur. 

In case of a stalemate, all units left on the battle board will stay organized (or be freely reorganized) in their armies which stay in the location of the battle. Any withdrawn units will become disorganized but also stay in the same location.

### Withdrawn units

Regardless of the outcome of the battle, all withdrawn units on both sides will separate from their armies and enter the disorganized state in the strategic map. 

In case of a victory, the winner's disorganized units will stay in the location of the battle while the loser's units will withdraw to a friendly or neutral adjacent node during the same turn after the battle.  
If the withdrawn disorganized unit is encircled and there are no neutral or friendly nodes to withdraw to, the disorganized units will be destroyed 

Winner of the battle can freely reorganize their remaining units that were not withdrawn in case multiple armies were present in the battle (it is assumed the players would not remember which units were in which army in case multiple armies were present in the location), however all units present in the battle stay revealed on the strategic map until reorganized and hidden in a controlled location.	

All withdrawn units will stay disorganized until they are formed back into an army in a controlled node or in the staging area

## Battle dice rolls

Every time a unit attacks another one, they roll equal amount of attack rolls to their Breakthrough value, and the defender rolls equal amount of defensive rolls to their Toughness value.

Attacker rolls:

1 - Critical failure - Attacking unit takes 1 HP damage
2 - Failure - No damage dealt
3 - Partial success - Deliver base damage -1
4 - Success - Deals unit's base damage
5 - Great success - Deals base damage and has possible defender damage reduced by 1
6 - Critical success - Deals base damage +1 and has defender damage reduced by 1

Defender rolls:

1 - Critical failure - Defending unit takes 1 HP damage regardless of attacker roll
2 - Failure - Receive attacker damage with no counter
3 - Partial success - Receive attacker's damage but counter with base damage -1
4 - Success - Reduce attacker damage by 1 and counter with base damage -1
5 - Great success - Reduce attacker damage by 1 and counter with base damage
6 - Critical success - Reduce attacker damage by 2 and counter with base damage

## Indirect fire

The strategic map has 4 locations which support indirect fire support to another location. 

When a battle commences in the locations targeted by the indirect fire, a single artillery unit (which must be attached to an army, not disorganized) can be revealed in the adjacent node and added to the battle board in the indirect fire support slot. This must be done immediately when the battle is initiated and cannot be done after the battle has started.

Indirect fire support can be used by both attacker and defender in the battles if they have a suitable unit available in a controlled node that allows indirect fire support

The indirect fire support can be used on any turn in the battle and can target any enemy units in the battle board which are currently available targets for friendly units. A player cannot use indirect fire support to damage the opponent's reserve units which are outside the attack range of any friendly units, or to damage the enemy when there are no friendly units remaining on the battle board.

To offset the "free damage" dealt by fire support, they receive a penalty of -1 Breakthrough when firing over the initial frontline into the opponent's side. Against any units on the same side of the board the standard artillery unit values apply. 

Damage from indirect fire can be reduced by the defender's dice throw, but any other units than Artillery cannot counter attack. In case the indirect fire support fires at an artillery unit anywhere on the board, the usual counter attack logic applies. Indirect fire support unit may receive damage from their own dice throw if they throw a critical failure.

Indirect fire support units can be targeted by an enemy artillery unit which has crossed the initial frontline of the battle field (ie. firing from the enemy's side of the board), in this case it is possible for the support unit to be damaged or destroyed.

Indirect fire support units can withdraw from the battle at any time using the action of the turn. The withdrawn support unit will not enter disorganized state but will stay revealed until reorganized in a controlled node.    

## Unit special abilities

### Artillery

Artillery units are able attack enemy units in the surrounding 8 locations similarly to other units, but are also able to fire over one deployment row in 90 degree angles with a 3 location attack radius, similarly to a knight movement on a chess board but including the locations in the middle of the L shape that a chess pawn would not be allowed to move into.

    Units which cannot reach the attacking artillery unit (ie. infantry 1 row further away) will have their normal defensive rolls to reduce the oncoming damage, but cannot deliver any counter damage. 

    Artillery unit will not move to the attacked location even if the enemy unit was destroyed but will need to be moved on another turn.

    Artillery vs Artillery duels can be dangerous due to the combination of high damage and low HP of the units.

### Infantry

Infantry units will not be outright destroyed after losing their 4 HP. Instead the unit enters the "wounded" state which allows them to attempt withdrawing while having their damage output modified by -1 (Rendering them mostly useless and completely unable to deal any hard attack that makes them very vulnerable against armor).

Infantry units cannot be "overkilled" (for example dealing 3 damage against 1 HP remaining) and they will always enter the wounded state when reaching 0 HP regardless of the damage dealt in the last attack.

If a wounded infantry unit is further attacked and damaged in a battle, it will be destroyed and removed from the game.

Wounded infantry units should be indicated by turning the card and related coin face down in the battle board or replaced by the wounded icon coin.   

Wounded infantry units can withdraw from the battle after which the strategic map unit should be marked as wounded and must stay facing up until moved back to home base to reinforce regardless of whether they are disorganized or in an army. 

Wounded units can be included in reorganized armies after battles, but they can’t participate in an attack against the enemy and if forced into a defensive engagement, they will enter the battle board in the wounded state.  
         

# Other rules and core gameplay loop

Each round starts with a dice roll for "initiative" to decide which player starts the sequence. Roll until one player has a greater value.

Each round is then split into player turns which have the different phases.

## Turn phases:

### Recon 

Players have 2 actions that can be performed with their recon units (movement or recon, can be separate units or 2 actions by the same one). Players take turns to perform the available recon actions.

If a player does not have any recon units remaining, their recon phase is skipped.

### Strategic

Players have 2 actions that can be performed in the strategic map with their armies and disorganized units. Each player completes their 2 actions sequentially without the other player’s turn in between.

Possible strategic actions:
 - Move units to adjacent location
 - Reorganize units in a controlled node or staging area
 - Construct defensive fortifications in locations they have armies in

Initiating battles does not consume a strategic action so it is possible for multiple battles to occur during a single turn. Players can decide to initiate the battles before or in between their strategic actions. If a player has strategic actions remaining after a battle, they continue their turn to take the actions. 

### Battle

When a battle is initiated in a location, the attacker chooses which of their armies make the assault, and the unit coins of those armies are moved onto the battle board together with the defender's entire organized garrison. The tactical battle is then fought. See the Tactical Battles section for details.  
After the battle any remaining units are moved back onto the same location on the strategic board in a revealed state. 

### Supply limit check

The final action the players should do during their turn is confirming any nodes they hold units in are not over the supply limits (6 per division slot in controlled locations, 3 per division slot in contested locations). Any location with units above the limit will have the topmost (latest arrived) exceeding units moved to disorganized state.

## Army reorganizing 

Reorganizing armies can be N-for-0 or N-for-N cards swapped between units. All units in the node where reorganization is done will be hidden in the fog of war and placed face down (regardless of whether they actually move between armies). If a location holds multiple armies, a single reorganization action allows freely moving units between all of them. 

Reorganization can be also used for simply re-hiding the units without moving any between other armies.

Only one new army can be created during a single reorganization action, but any number of existing armies can be involved in the process.

Reorganization cannot create new armies if the location does not have a free division slot for the new army to be placed.

Example case: 
A controlled location with 3 division slots (total 18 supply) holds 3 disorganized units and 2 armies of 3 units, one that has been fully revealed and one that is hidden. Reorganization allows mixing any units present in the location and creating one new army if the player wishes, allowing an end result where the player has 3 armies of different sizes, all in the hidden state. 
The same units present in a location with only 2 slots would be able to reorganize into 2 armies with no disorganized units, but can't create a new army as the location doesn't have space for it.

Reorganizing wounded units in the staging area reinforces them back into full infantry units and hides them. If a wounded unit is part of a reorganization outside the staging area, they may become a part of an army but will stay revealed and wounded.

Units can be split off armies into disorganized state without spending strategic actions.

## Winning the game

The game is won by a player that occupies all locations adjacent to the enemy staging area for 2 full rounds (ie. both players have 2 turns, regardless of the order given by the initiative dice rolls). If any of the locations are relieved by the opponent, the counter is reset and the locations must be held for another 2 rounds if the attacker gains control of them again. 
